/** Many people at once: the model-call limiter, a Telegram poll that never waits for an answer, the dashboard /api/chat route end to end, and the XRayDar tool. `npm test` (no network). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const { Semaphore, limitProvider } = require("../src/limit.js");
const { poll } = require("../src/telegram.js");
const { Bot } = require("../src/bot.js");
const { Store, RateLimiter } = require("../src/state.js");
const cfgMod = require("../src/config.js");
const { XRayDarClient, makeTools } = require("../src/tools/xraydar.js");
const { buildTools } = require("../src/tools/index.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gqc-"));

test("limiter: never more than max model calls at once, every call completes, first come first served", async () => {
  const sem = new Semaphore(3);
  let now = 0, peak = 0;
  const order = [];
  await Promise.all(Array.from({ length: 20 }, (_, i) => sem.run(async () => {
    now++; peak = Math.max(peak, now); order.push(i);
    await sleep(5);
    now--;
  })));
  assert.equal(peak, 3);
  assert.deepEqual(order, [...Array(20).keys()]);
  assert.equal(sem.active, 0);
  assert.equal(sem.waiting, 0);
});

test("limiter: a failing call frees its slot", async () => {
  const sem = new Semaphore(1);
  await assert.rejects(sem.run(async () => { throw new Error("boom"); }));
  assert.equal(await sem.run(async () => 7), 7);
});

test("limiter: the wrapped provider keeps its name, model and lastModel", () => {
  const p = { name: "grok", model: "m1", lastModel: "m2", chat: async () => ({}) };
  const w = limitProvider(p, new Semaphore(2));
  assert.equal(w.name, "grok"); assert.equal(w.model, "m1"); assert.equal(w.lastModel, "m2");
  p.lastModel = "m3"; assert.equal(w.lastModel, "m3");
});

test("telegram poll: a slow answer in one chat does not hold up the next person's message", async () => {
  const batches = [[{ update_id: 1 }, { update_id: 2 }]];
  const ac = new AbortController();
  const client = { log: () => {}, getUpdates: async () => { const b = batches.shift(); if (!b) { ac.abort(); return []; } return b; } };
  const seen = [];
  let releaseFirst;
  const firstDone = new Promise((r) => { releaseFirst = r; });
  const inflight = await poll(client, async (u) => {
    if (u.update_id === 1) { await firstDone; seen.push("1 done"); }
    else { seen.push("2 done"); releaseFirst(); }
  }, { signal: ac.signal, onError: () => {} });
  await Promise.allSettled([...inflight]);
  assert.deepEqual(seen, ["2 done", "1 done"]);
});

function makeBot(over = {}) {
  const cfg = cfgMod.load({ TELEGRAM_BOT_TOKEN: "1:x", XAI_API_KEY: "k", DATA_DIR: tmp(), AGENT_RATE_PER_MIN: "100", AGENT_MAX_QUEUED_PER_PERSON: "2", ...over });
  let active = 0, peak = 0;
  const seenUsers = [];
  const provider = limitProvider({
    name: "grok", model: "fake",
    async chat({ system, messages }) {
      active++; peak = Math.max(peak, active);
      await sleep(40);
      active--;
      const who = /You are talking to ([^<]+)</.exec(system);
      seenUsers.push(who && who[1].trim());
      return { text: `answer for ${who && who[1].trim()}: ${messages.at(-1).content.split("\n")[0]}`, toolCalls: [], usage: { in: 10, out: 5 } };
    },
  }, new Semaphore(cfg.maxParallelModelCalls));
  const logs = [];
  const bot = new Bot({ cfg, tg: {}, provider, store: new Store(cfg.dataDir, () => {}), snapshots: null, live: {}, limiter: new RateLimiter(cfg.ratePerMin), log: (m) => logs.push(m), ...over.botExtra });
  return { bot, stats: () => ({ peak, seenUsers }), logs };
}

test("dashboard: 25 people asking at once are answered in parallel, each with their own answer", async () => {
  const { bot, stats } = makeBot({ AGENT_MAX_PARALLEL_MODEL_CALLS: "10" });
  const t0 = Date.now();
  const outs = await Promise.all(Array.from({ length: 25 }, (_, i) =>
    bot.webAsk({ user: { email: `person${i}@gquants.com`, name: `Person ${i}` }, message: `question ${i}` })));
  const ms = Date.now() - t0;
  outs.forEach((o, i) => {
    assert.match(o.answer, new RegExp(`Person ${i}: question ${i}$`));
    assert.equal(o.model, "fake");
  });
  assert.ok(stats().peak <= 10, `at most 10 model calls at once, saw ${stats().peak}`);
  assert.ok(stats().peak >= 5, "calls really ran in parallel");
  assert.ok(ms < 25 * 40, `parallel, not one after another (${ms} ms)`);
});

test("dashboard: one person's questions run in order; too many waiting is refused politely", async () => {
  const { bot } = makeBot();
  const u = { email: "a@gquants.com", name: "A" };
  const p1 = bot.webAsk({ user: u, message: "first" });
  const p2 = bot.webAsk({ user: u, message: "second" });
  await assert.rejects(bot.webAsk({ user: u, message: "third" }), (e) => e.status === 429);
  const [a1, a2] = await Promise.all([p1, p2]);
  assert.match(a1.answer, /first$/);
  assert.match(a2.answer, /second$/);
});

test("dashboard: the on-screen context and history reach the model; bad input is a 400", async () => {
  let got = null;
  const { bot } = makeBot();
  bot._engines = { grok: { name: "grok", model: "fake", chat: async (args) => { got = args; return { text: "ok", toolCalls: [], usage: {} }; } } };
  await bot.webAsk({ user: { email: "b@gquants.com" }, message: "is this stock rising?", history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }], context: { page: "chartlab", symbol: "INFY", name: "Infosys", country: "India", tf: "W" } });
  const last = got.messages.at(-1).content;
  assert.match(last, /INFY · Infosys \(India\)/);
  assert.match(last, /timeframe W/);
  assert.equal(got.messages[0].content, "hi");
  assert.match(got.system, /agent panel of GQ XRayDar/);
  await assert.rejects(bot.webAsk({ user: { email: "nope" }, message: "x" }), (e) => e.status === 400);
  await assert.rejects(bot.webAsk({ user: { email: "c@gquants.com" }, message: "  " }), (e) => e.status === 400);
});

test("xraydar tool: calls the app's API with the shared secret and the asker's Telegram id; declared only when connected and selected", async () => {
  const calls = [];
  const client = new XRayDarClient({ url: "https://ta.example/", secret: "s3cret", fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => ({ ok: 1 }) }; } });
  const [tool] = makeTools(["gq-xraydar"], client);
  await tool.run({ action: "fields", search: "kst" }, {});
  await tool.run({ action: "screen", conditions: [{ field: "capUsd", op: ">", value: "10000000000" }], scope: { country: "United States" } }, {});
  await tool.run({ action: "review", watchlist: "core" }, { member: { telegramId: "42" } });
  assert.equal(calls[0].url, "https://ta.example/api/fields?search=kst&group=");
  assert.equal(calls[0].opts.headers["x-ta-secret"], "s3cret");
  assert.equal(JSON.parse(calls[1].opts.body).scope.country, "United States");
  assert.equal(calls[2].opts.headers["x-telegram-user"], "42");
  assert.deepEqual(await tool.run({ action: "screen" }, {}), { error: "give a condition, a scope or a sort; look the field keys up with action=fields first" });
  assert.equal(makeTools(["busybee"], client).length, 0);
  assert.equal(makeTools(["gq-xraydar"], new XRayDarClient({})).length, 0);
  const names = buildTools({ selected: ["gq-xraydar"], xraydar: client }).map((t) => t.name);
  assert.ok(names.includes("xraydar"));
});

test("server: POST /api/chat needs the shared secret and answers many dashboard questions at once", async () => {
  const fakeX = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => setTimeout(() => {
      const body = JSON.parse(b);
      const q = body.messages.at(-1).content.split("\n")[0];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: `Answer to ${q}` }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
    }, 30));
  });
  const tg = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      const method = req.url.split("/").pop();
      const reply = (r) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result: r })); };
      if (method === "getMe") return reply({ id: 9, is_bot: true, first_name: "T", username: "conc_test_bot" });
      if (method === "getUpdates") return setTimeout(() => reply([]), 300);
      return reply(true);
    });
  });
  await new Promise((r) => fakeX.listen(0, "127.0.0.1", r));
  await new Promise((r) => tg.listen(0, "127.0.0.1", r));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { PATH: process.env.PATH, HOME: os.tmpdir(), TELEGRAM_BOT_TOKEN: "1:concToken", TELEGRAM_API_BASE: `http://127.0.0.1:${tg.address().port}`, XAI_API_KEY: "k", XAI_API_URL: `http://127.0.0.1:${fakeX.address().port}/v1/chat/completions`, TA_API_SECRET: "shared-secret-123", PORT: String(port), DATA_DIR: tmp(), SNAPSHOT_REFRESH_MINUTES: "100000", AGENT_RATE_PER_MIN: "100" };
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { up = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { /* starting */ } }
    assert.ok(up, out.slice(-400));
    const post = (body, secret) => fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-ta-secret": secret } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post({ message: "hi", user: { email: "a@gquants.com" } })).status, 401);
    assert.equal((await post({ message: "hi", user: { email: "a@gquants.com" } }, "wrong-secret-12345")).status, 401);
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => post({ message: `q${i}`, user: { email: `p${i}@gquants.com`, name: `P${i}` } }, "shared-secret-123")));
    const js = await Promise.all(rs.map((r) => r.json()));
    rs.forEach((r, i) => assert.equal(r.status, 200, JSON.stringify(js[i])));
    js.forEach((j, i) => assert.equal(j.answer, `Answer to q${i}`));
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(h.dashboard, true);
  } finally {
    child.kill(); fakeX.close(); tg.close();
  }
});

test("dashboard guest (no login): answered, but with no project, database, ETI or BusyBee tools and never admin", async () => {
  let got = null;
  const { bot } = makeBot();
  bot._engines = { grok: { name: "grok", model: "fake", chat: async (args) => { got = args; return { text: "ok", toolCalls: [], usage: {} }; } } };
  const out = await bot.webAsk({ user: { guest: true, guestId: "abc123" }, message: "top 5 US stocks by market cap" });
  assert.equal(out.answer.trim().split("\n")[0], "ok");
  assert.match(got.system, /visitor to the GQ XRayDar dashboard/);
  const names = (got.tools || []).map((t) => t.name);
  assert.ok(!names.some((n) => /^project_|^eti_|busybee|repo|github/i.test(n)), `guest tools: ${names.join(",")}`);
  await assert.rejects(bot.webAsk({ user: { guest: true }, message: "x" }), (e) => e.status === 400);
  const { buildTools } = require("../src/tools");
  const guestTools = buildTools({ selected: [], xraydar: new (require("../src/tools/xraydar").XRayDarClient)({ url: "https://x", secret: "s" }), xraydarAlways: true }).map((t) => t.name);
  assert.ok(guestTools.some((n) => /xraydar/.test(n)), `guest gets the xraydar data tool: ${guestTools.join(",")}`);
  assert.ok(!guestTools.some((n) => /repo|github/i.test(n)), "but no code tools");
});
