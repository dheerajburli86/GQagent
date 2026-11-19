/** Grok is the only engine: old tags are stripped; Grok always gets live web search. `npm test` (no network). */
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

test("old tags (@grok, @deepinfra, @both) are removed; look-alikes are kept", () => {
  assert.deepEqual(parseEngines("@grok what moved the yen?"), { mode: "default", text: "what moved the yen?" });
  assert.deepEqual(parseEngines("@grok @deepinfra RBI policy today"), { mode: "default", text: "RBI policy today" });
  assert.equal(parseEngines("what is CAGR @DeepInfra").text, "what is CAGR");
  assert.equal(parseEngines("ask @grokbot or email me@grok.com").text, "ask @grokbot or email me@grok.com");
});

test("plan: Grok when the key is set; a clear message when it is not", () => {
  assert.deepEqual(plan("default", { grok: {} }).use, ["grok"]);
  assert.match(plan("default", { grok: null }).error, /XAI_API_KEY/);
  assert.equal(createEngines(cfgMod.load({ XAI_API_KEY: "x" })).grok.name, "grok");
  assert.equal(createEngines(cfgMod.load({ DEEPINFRA_API_KEY: "d" })).grok, null);
});

const fake = (answer, log) => ({ name: "grok", model: "grok-4.3", chat: async (a) => { log.push(a); return { text: answer, toolCalls: [], usage: { in: 10, out: 5 } }; } });
const research = { name: "web_research", description: "grok search", parameters: { type: "object", properties: { q: { type: "string" } } }, run: async () => ({}) };

test("run: every question gets Grok's web_research tool", async () => {
  const log = [];
  const r = await runWithEngines({ mode: "default", engines: { grok: fake("G-ans", log) }, researchTool: research, buildTools: (t) => (t ? [t] : []), buildSystem: (n) => `sys ${n}`, ctx: { usage: { in: 0, out: 0 } }, history: [], message: "q", maxSteps: 3 });
  assert.equal(r.answer, "G-ans");
  assert.deepEqual(log[0].tools.map((t) => t.name), ["web_research"]);
});

function world(grok) {
  const cfg = cfgMod.load({ TELEGRAM_BOT_TOKEN: "1:x", DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "gqe-")), AGENT_RATE_PER_MIN: "100" });
  const sent = [];
  const f = async (url, o = {}) => { const method = new URL(url).pathname.split("/").pop(); const body = o.body ? JSON.parse(o.body) : {}; if (method === "sendMessage") sent.push(body); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })); };
  const store = new Store(cfg.dataDir, () => {});
  const snapshots = new SnapshotStore({ projects: PROJECTS, log: () => {} });
  const engines = { grok };
  const bot = new Bot({ cfg, tg: new TelegramClient({ token: "1:x", fetchImpl: f, log: () => {} }), provider: grok, engines, store, snapshots, live: {}, limiter: new RateLimiter(100), log: () => {}, researchTool: research });
  bot.me = { id: 999, username: "gq_agent_bot" };
  bot.runner = new TaskRunner({ cfg, store, engines, provider: grok, snapshots, live: {}, researchTool: research, isChatAllowed: () => true, log: () => {}, post: async () => {} });
  return { bot, sent, store, cfg, snapshots, engines };
}
const dm = (text) => ({ update_id: Math.floor(Math.random() * 1e6), message: { message_id: 5, chat: { id: 7, type: "private" }, from: { id: 7, first_name: "A" }, text } });

test("telegram: Grok answers with no label; tags never reach the model; no key -> setup message", async () => {
  const log = [];
  const w = world(fake("G-ans", log));
  await w.bot.handle(dm("@grok latest on the yen"));
  assert.equal(w.sent.at(-1).text, "G-ans");
  assert.equal(log.at(-1).messages.at(-1).content, "latest on the yen");
  assert.ok(log.at(-1).tools.some((t) => t.name === "web_research"));
  const none = world(null);
  await none.bot.handle(dm("hi"));
  assert.match(none.sent.at(-1).text, /not fully set up/);
});

test("tasks: old '@grok' task tags still work and run on Grok", async () => {
  const log = [];
  const w = world(fake("NOTHING_NEW", log));
  await w.bot.handle(dm("/task add daily 09:00 | @grok yen and BoJ news"));
  const t = w.store.getTask(1);
  assert.equal(t.instruction, "yen and BoJ news");
  log.length = 0;
  await executeTask(t, { engines: w.engines, cfg: w.cfg, store: w.store, snapshots: w.snapshots, researchTool: research });
  assert.equal(log.length >= 1, true);
});
