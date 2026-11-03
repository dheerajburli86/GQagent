/** @grok / @deepinfra / both: which AI answers, and the merge. `npm test` (no network). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseEngines, plan, createEngines, runWithEngines } = require("../src/engines.js");
const { Store, RateLimiter } = require("../src/state.js");
const { Bot } = require("../src/bot.js");
const { TaskRunner, executeTask } = require("../src/tasks.js");
const { TelegramClient } = require("../src/telegram.js");
const { SnapshotStore } = require("../src/snapshots.js");
const { PROJECTS } = require("../src/projects.js");
const cfgMod = require("../src/config.js");

test("tags: @grok, @deepinfra, both, @both, none; tags are removed; look-alikes are not tags", () => {
  assert.deepEqual(parseEngines("@grok what moved the yen?"), { mode: "grok", text: "what moved the yen?" });
  assert.deepEqual(parseEngines("what is CAGR @DeepInfra"), { mode: "deepinfra", text: "what is CAGR" });
  assert.deepEqual(parseEngines("@grok @deepinfra RBI policy today"), { mode: "both", text: "RBI policy today" });
  assert.equal(parseEngines("@both RBI").mode, "both");
  assert.equal(parseEngines("@deep-infra x").mode, "deepinfra");
  assert.deepEqual(parseEngines("plain question"), { mode: "default", text: "plain question" });
  assert.equal(parseEngines("ask @grokbot or email me@grok.com").mode, "default", "@grokbot and emails are not the tag");
  assert.equal(parseEngines("@grok_fan hi").mode, "default");
});

test("plan: default and @deepinfra use DeepInfra only; @grok needs Grok; both needs both; clear messages when a key is missing", () => {
  const both = { deepinfra: {}, grok: {} };
  assert.deepEqual(plan("default", both).use, ["deepinfra"], "Grok is never used without the tag");
  assert.deepEqual(plan("deepinfra", both).use, ["deepinfra"]);
  assert.deepEqual(plan("grok", both).use, ["grok"]);
  assert.deepEqual(plan("both", both).use, ["deepinfra", "grok"]);
  assert.match(plan("grok", { deepinfra: {} }).error, /Grok isn't set up[\s\S]*XAI_API_KEY/);
  assert.match(plan("both", { deepinfra: {} }).error, /Grok isn't set up/);
  assert.match(plan("deepinfra", { grok: {} }).error, /DEEPINFRA_API_KEY/);
  assert.deepEqual(plan("default", { grok: {} }).use, ["grok"], "a Grok-only setup still answers untagged questions");
  const e = createEngines(cfgMod.load({ DEEPINFRA_API_KEY: "d", XAI_API_KEY: "x" }));
  assert.equal(e.deepinfra.name, "deepinfra"); assert.equal(e.grok.name, "grok");
  assert.equal(createEngines(cfgMod.load({ XAI_API_KEY: "x" })).deepinfra, null, "no silent swap between providers");
});

const fake = (name, answer, log, { fail = false } = {}) => ({
  name, model: name,
  chat: async (a) => { log.push({ name, a }); if (fail) throw new Error(`${name} down`); return { text: a.system.startsWith("You combine") ? `MERGED(${a.messages[0].content.includes("FIRST ANSWER:\nD-ans") && a.messages[0].content.includes("SECOND ANSWER:\nG-ans")})` : answer, toolCalls: [], usage: { in: 10, out: 5 } }; },
});
const research = { name: "web_research", description: "grok search", parameters: { type: "object", properties: { q: { type: "string" } } }, run: async () => ({}) };
const args = (mode, engines) => ({
  mode, engines, researchTool: research,
  buildTools: (r) => (r ? [r] : []), buildSystem: (names) => `sys tools=${names.join(",")}`,
  ctx: { usage: { in: 0, out: 0 } }, history: [], message: "RBI policy?", maxSteps: 3,
});

test("run: Grok gets its search tool; DeepInfra never does; both run in parallel and DeepInfra merges into one answer", async () => {
  let log = [];
  const eng = { deepinfra: fake("deepinfra", "D-ans", log), grok: fake("grok", "G-ans", log) };
  const d = await runWithEngines(args("default", eng));
  assert.equal(d.answer, "D-ans"); assert.deepEqual(log.map((x) => x.name), ["deepinfra"]);
  assert.equal(log[0].a.tools.length, 0, "no Grok search when Grok wasn't asked for");
  log.length = 0;
  const g = await runWithEngines(args("grok", eng));
  assert.equal(g.answer, "G-ans"); assert.deepEqual(log.map((x) => x.name), ["grok"]);
  assert.deepEqual(log[0].a.tools.map((t) => t.name), ["web_research"]);
  log.length = 0;
  const a = args("both", eng);
  const b = await runWithEngines(a);
  assert.equal(b.answer, "MERGED(true)", "the merge sees both answers");
  assert.deepEqual(log.map((x) => x.name).sort(), ["deepinfra", "deepinfra", "grok"]);
  assert.match(log.at(-1).a.system, /^You combine two AI answers/);
  assert.equal(log.at(-1).name, "deepinfra", "DeepInfra writes the merged answer");
  assert.equal(a.ctx.usage.in, 30, "all three calls are counted");
});

test("run: in 'both', if one engine fails the other's answer is returned and marked partial; if both fail it errors", async () => {
  const log = [];
  const r = await runWithEngines(args("both", { deepinfra: fake("deepinfra", "D-ans", log), grok: fake("grok", "G", log, { fail: true }) }));
  assert.equal(r.answer, "D-ans"); assert.equal(r.partial, true); assert.deepEqual(r.engines, ["deepinfra"]);
  await assert.rejects(() => runWithEngines(args("both", { deepinfra: fake("d", "", log, { fail: true }), grok: fake("g", "", log, { fail: true }) })), /down/);
  await assert.rejects(() => runWithEngines(args("grok", { deepinfra: fake("d", "", log) })), (e) => e.userFacing && /Grok isn't set up/.test(e.message));
});

function world(engines) {
  const cfg = cfgMod.load({ TELEGRAM_BOT_TOKEN: "1:x", DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "gqe-")), AGENT_RATE_PER_MIN: "100" });
  const sent = [];
  const f = async (url, o = {}) => { const method = new URL(url).pathname.split("/").pop(); const body = o.body ? JSON.parse(o.body) : {}; if (method === "sendMessage") sent.push(body); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })); };
  const store = new Store(cfg.dataDir, () => {});
  const snapshots = new SnapshotStore({ projects: PROJECTS, log: () => {} });
  const bot = new Bot({ cfg, tg: new TelegramClient({ token: "1:x", fetchImpl: f, log: () => {} }), provider: engines.deepinfra, engines, store, snapshots, live: {}, limiter: new RateLimiter(100), log: () => {}, researchTool: research });
  bot.me = { id: 999, username: "gq_agent_bot" };
  bot.runner = new TaskRunner({ cfg, store, engines, provider: engines.deepinfra, snapshots, live: {}, researchTool: research, isChatAllowed: () => true, log: () => {}, post: async () => {} });
  return { bot, sent, store, cfg, snapshots };
}
const dm = (text) => ({ update_id: Math.floor(Math.random() * 1e6), message: { message_id: 5, chat: { id: 7, type: "private" }, from: { id: 7, first_name: "A" }, text } });

test("telegram: the tag picks the AI, the model never sees the tag, and a tagged answer says who answered", async () => {
  const log = [];
  const w = world({ deepinfra: fake("deepinfra", "D-ans", log), grok: fake("grok", "G-ans", log) });
  await w.bot.handle(dm("what is 2+2"));
  assert.equal(w.sent.at(-1).text, "D-ans", "untagged: DeepInfra, no label");
  await w.bot.handle(dm("@grok latest on the yen"));
  assert.equal(w.sent.at(-1).text, "G-ans\n\n🤖 Grok");
  assert.equal(log.at(-1).a.messages.at(-1).content, "latest on the yen");
  await w.bot.handle(dm("@grok @deepinfra RBI policy"));
  assert.equal(w.sent.at(-1).text, "MERGED(true)\n\n🤖 Grok + DeepInfra");
  const noGrok = world({ deepinfra: fake("deepinfra", "D", []), grok: null });
  await noGrok.bot.handle(dm("@grok hi"));
  assert.match(noGrok.sent.at(-1).text, /Grok isn't set up/);
});

test("tasks: '/task add ... | @grok ...' keeps Grok for every run; untagged tasks stay on DeepInfra", async () => {
  const log = [];
  const engines = { deepinfra: fake("deepinfra", "NOTHING_NEW", log), grok: fake("grok", "NOTHING_NEW", log) };
  const w = world(engines);
  await w.bot.handle(dm("/task add daily 09:00 | @grok yen and BoJ news"));
  const t = w.store.getTask(1);
  assert.equal(t.engine, "grok"); assert.equal(t.instruction, "yen and BoJ news");
  log.length = 0;
  await executeTask(t, { engines, cfg: w.cfg, store: w.store, snapshots: w.snapshots, researchTool: research });
  assert.deepEqual(log.map((x) => x.name), ["grok"]);
  w.bot.runner.create({ chatId: "7", createdBy: "7", instruction: "plain daily macro news", scheduleText: "daily 10:00" });
  log.length = 0;
  await executeTask(w.store.getTask(2), { engines, cfg: w.cfg, store: w.store, snapshots: w.snapshots, researchTool: research });
  assert.deepEqual(log.map((x) => x.name), ["deepinfra"]);
});
