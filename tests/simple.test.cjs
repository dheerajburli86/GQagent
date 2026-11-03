/** The simple, tap-first experience for non-technical people. `npm test` (no network). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Store, RateLimiter } = require("../src/state.js");
const { Bot, MENU, HELP } = require("../src/bot.js");
const { TaskRunner } = require("../src/tasks.js");
const { TelegramClient } = require("../src/telegram.js");
const { SnapshotStore } = require("../src/snapshots.js");
const { PROJECTS } = require("../src/projects.js");
const cfgMod = require("../src/config.js");

const CFG = () => cfgMod.load({ TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_ALLOWED_USER_IDS: "111,222", TELEGRAM_ADMIN_USER_IDS: "111", TELEGRAM_ALLOWED_GROUP_IDS: "-100500", DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "gqs-")), AGENT_RATE_PER_MIN: "100" });

function world() {
  const cfg = CFG();
  const calls = [];
  const f = async (url, o = {}) => {
    const method = new URL(url).pathname.split("/").pop();
    const body = o.body ? JSON.parse(o.body) : {};
    calls.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: 900 + calls.length } : true }), { status: 200 });
  };
  const tg = new TelegramClient({ token: "1:x", fetchImpl: f, log: () => {} });
  const store = new Store(cfg.dataDir, () => {});
  const prompts = [];
  const provider = { name: "fake", model: "m", chat: async (a) => { prompts.push(a); return { text: "Markets were mixed today.", toolCalls: [], usage: { in: 1, out: 1 } }; } };
  const snapshots = new SnapshotStore({ projects: PROJECTS, log: () => {} });
  const bot = new Bot({ cfg, tg, provider, store, snapshots, live: {}, limiter: new RateLimiter(100), log: () => {} });
  bot.me = { id: 999, username: "gq_agent_bot" };
  const runs = [];
  bot.runner = new TaskRunner({ cfg, store, provider, snapshots, live: {}, isChatAllowed: () => true, log: () => {}, post: async () => {} });
  bot.runner.run = (id, o) => { runs.push({ id, o }); return Promise.resolve(); };
  const sent = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.body);
  return { bot, calls, sent, store, prompts, runs };
}
const DM = { id: 111, type: "private" };
const msg = (text, chat = DM, from = { id: 111, first_name: "Dheeraj" }) => ({ message_id: 5, chat, from, text });
const tap = (data, { chat = DM, from = { id: 111 }, text = "🔔 Regular updates in this chat" } = {}) => ({ update_id: 50, callback_query: { id: "cb", from, data, message: { message_id: 77, chat, text } } });

test("simple: /start shows a short welcome with four big buttons (a keyboard in DMs, inline buttons in groups)", async () => {
  const w = world();
  await w.bot.handle({ update_id: 1, message: msg("/start") });
  const dm = w.sent().at(-1);
  assert.match(dm.text, /Just type your question/);
  assert.ok(HELP.length < 1100, "the welcome stays short");
  assert.doesNotMatch(dm.text, /\/task|\/projects|\/list /, "no commands to learn");
  assert.deepEqual(dm.reply_markup.keyboard.flat().map((b) => b.text), [MENU.market, MENU.updates, MENU.lists, MENU.help]);
  await w.bot.handle({ update_id: 2, message: msg("/start", { id: -100500, type: "supergroup" }) });
  assert.deepEqual(w.sent().at(-1).reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ["m:market", "m:updates", "m:lists", "m:help"]);
});

test("simple: tapping the buttons does the job without typing anything", async () => {
  const w = world();
  await w.bot.handle({ update_id: 1, message: msg(MENU.updates) });
  assert.match(w.sent().at(-1).text, /don't have any regular updates[\s\S]*Every morning at 9/);
  await w.bot.handle({ update_id: 2, message: msg(MENU.lists) });
  assert.match(w.sent().at(-1).text, /No stock lists saved yet/);
  await w.bot.handle({ update_id: 3, message: msg(MENU.market) });
  assert.match(w.prompts.at(-1).messages.at(-1).content, /market summary/, "without live data it summarises from the news");
  assert.equal(w.sent().at(-1).text, "Markets were mixed today.");
  await w.bot.handle(tap("m:updates"));
  assert.match(w.sent().at(-1).text, /regular updates/);
  await w.bot.handle({ update_id: 4, message: msg("/updates") });
  await w.bot.handle({ update_id: 5, message: msg("/foo") });
  assert.match(w.sent().at(-1).text, /You don't need any: just type/);
});

test("simple: updates are managed with buttons; only the person who set one up (or an admin) can pause or remove it", async () => {
  const w = world();
  w.bot.runner.create({ chatId: "111", createdBy: "111", instruction: "Every weekday at 9, news on our India stocks", scheduleText: "weekdays 09:00", title: "India stocks news" });
  await w.bot.handle({ update_id: 1, message: msg(MENU.updates) });
  const v = w.sent().at(-1);
  assert.match(v.text, /1\. India stocks news\n    Every weekday at 09:00 · next: /);
  assert.deepEqual(v.reply_markup.inline_keyboard[0].map((b) => b.text), ["▶️ Send 1 now", "⏸ Pause 1", "🗑 Remove 1"]);

  await w.bot.handle(tap("t:run:1"));
  assert.equal(w.runs[0].id, 1); assert.equal(w.runs[0].o.manual, true);
  await w.bot.handle(tap("t:pause:1"));
  assert.equal(w.store.getTask(1).enabled, false);
  assert.match(w.calls.filter((c) => c.method === "editMessageText").at(-1).body.text, /⏸ \(paused\) India stocks news/, "the list refreshes in place");
  await w.bot.handle(tap("t:resume:1"));
  assert.equal(w.store.getTask(1).enabled, true);

  await w.bot.handle(tap("t:del:1"));
  assert.match(w.calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1).body.reply_markup.inline_keyboard[0][0].text, /Yes, remove/, "removal asks once to confirm");
  await w.bot.handle(tap("t:keep:1"));
  assert.ok(w.store.getTask(1), "keep: nothing removed");

  w.bot.runner.create({ chatId: "-100500", createdBy: "111", instruction: "Macro news for India every morning", scheduleText: "daily 08:30", title: "India macro" });
  const group = { id: -100500, type: "supergroup" };
  await w.bot.handle(tap("t:pause:2", { chat: group, from: { id: 222 } }));
  assert.match(w.calls.filter((c) => c.method === "answerCallbackQuery").at(-1).body.text, /Only the person who set it up/);
  assert.equal(w.store.getTask(2).enabled, true);
  await w.bot.handle(tap("t:run:2", { chat: group, from: { id: 222 } }));
  assert.equal(w.runs.at(-1).id, 2, "anyone in the chat may ask for an update now");
  await w.bot.handle(tap("t:delok:2", { chat: { id: -100999, type: "supergroup" } }));
  assert.ok(w.store.getTask(2), "a button from another chat cannot touch it");
  await w.bot.handle(tap("t:delok:1"));
  assert.equal(w.store.getTask(1), null);
});

test("simple: every posted update carries a one-tap pause button, which then offers resume", async () => {
  const w = world();
  w.bot.runner.create({ chatId: "111", createdBy: "111", instruction: "TCS news every two hours please", scheduleText: "every 2h", title: "TCS news" });
  assert.deepEqual(w.bot.updateButtons(1).inline_keyboard[0].map((b) => b.callback_data), ["t:pause:1", "m:updates"]);
  await w.bot.handle(tap("t:pause:1", { text: "🔔 TCS news\n\nTCS signs a deal" }));
  assert.equal(w.store.getTask(1).enabled, false);
  assert.equal(w.calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1).body.reply_markup.inline_keyboard[0][0].callback_data, "t:resume:1");
});

test("simple: answers carry no technical footer unless a project was read; the prompt asks for plain words", async () => {
  const w = world();
  await w.bot.handle({ update_id: 1, message: msg("how is the market") });
  assert.equal(w.sent().at(-1).text, "Markets were mixed today.");
  assert.match(w.prompts.at(-1).system, /Many readers are not technical/);
  assert.match(w.prompts.at(-1).system, /Never tell people to type slash commands/);
});

test("simple: a slow answer gets a short 'looking into it' note, removed when the answer arrives", async () => {
  const w = world();
  w.bot.cfg = { ...w.bot.cfg, waitNoteMs: 20 };
  w.bot.provider = { name: "fake", model: "m", chat: async () => { await new Promise((r) => setTimeout(r, 80)); return { text: "Done.", toolCalls: [], usage: { in: 1, out: 1 } }; } };
  await w.bot.handle({ update_id: 1, message: msg("research something slow") });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(w.sent().some((s) => /Looking into it/.test(s.text)));
  assert.ok(w.calls.some((c) => c.method === "deleteMessage"), "the note is removed");
  assert.equal(w.sent().at(-1).text, "Done.");
});
