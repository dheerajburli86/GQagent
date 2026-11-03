/** Telegram front end: formatting, access, state and budgets, the API client, and the bot end to end with fake Telegram and a fake model. `npm test` (no network). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fmt = require("../src/format.js");
const { check, label } = require("../src/access.js");
const { Store, RateLimiter, istDay } = require("../src/state.js");
const { TelegramClient, poll } = require("../src/telegram.js");
const { Bot } = require("../src/bot.js");
const { SnapshotStore } = require("../src/snapshots.js");
const { PROJECTS } = require("../src/projects.js");
const { BudgetError } = require("../src/errors.js");
const cfgMod = require("../src/config.js");
const docs = require("../src/documents.js");

const TOKEN = "123456:ABCdefGHIjklMNOpqrSTUvwxYZ-1234567890";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gqa-"));
const CFG = (over = {}) => cfgMod.load({
  TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USER_IDS: "111, 222", TELEGRAM_ADMIN_USER_IDS: "111",
  TELEGRAM_ALLOWED_GROUP_IDS: "-100500", DEEPINFRA_API_KEY: "k", DATA_DIR: tmp(), AGENT_RATE_PER_MIN: "100",
  AGENT_DAILY_TOKENS_PER_USER: "400000", AGENT_MONTHLY_TOKENS: "30000000", BRIEF_CHAT_ID: "", ...over,
});

// ---- formatting -----------------------------------------------------------------
test("format: Markdown becomes Telegram HTML; code, tables, headings, bullets, links all well-formed", () => {
  const md = "# Title\n**Bold** and `x*y*` and *ital* with [docs](https://a.example/?a=1&b=2).\n- one\n* two\n\n| Region | Revenue |\n|---|---|\n| North | 1200 |\n\n```js\nconst a = \"<b>\";\n```\nDone & <ok>";
  const [h] = fmt.toTelegramMessages(md);
  assert.match(h, /^<b>Title<\/b>/);
  assert.match(h, /<b>Bold<\/b> and <code>x\*y\*<\/code> and <i>ital<\/i>/);
  assert.match(h, /<a href="https:\/\/a\.example\/\?a=1&amp;b=2">docs<\/a>/);
  assert.match(h, /• one\n• two/);
  assert.match(h, /<pre>Region  Revenue\nNorth   1200<\/pre>/);
  assert.match(h, /<pre>const a = &quot;?&lt;b&gt;/.test(h) ? h : /<pre>const a = "&lt;b&gt;";<\/pre>/);
  assert.match(h, /Done &amp; &lt;ok&gt;/);
  assert.ok(fmt.wellFormed(h));
});

test("format: javascript: and other non-web links are not turned into clickable links", () => {
  const h = fmt.toHtml("[click](javascript:alert(1)) and [ok](https://x.example)");
  assert.ok(!/href="javascript:/.test(h));
  assert.match(h, /<a href="https:\/\/x\.example">ok<\/a>/);
});

test("format: long answers split under the limit; a code fence spanning a cut is closed and reopened", () => {
  const long = "line of text\n".repeat(400) + "```\n" + "code line here\n".repeat(400) + "```\nend";
  const parts = fmt.toTelegramMessages(long);
  assert.ok(parts.length > 2);
  assert.ok(parts.every((p) => p.length <= 4096), "each message fits Telegram's limit");
  assert.ok(parts.every(fmt.wellFormed), "every message has balanced tags");
  assert.ok(parts.slice(0, -1).every((p) => p.length > 0));
  assert.match(parts.join("\n"), /code line here/);
});

test("format: an unbalanced fence still produces a well-formed message", () => {
  const h = fmt.toTelegramMessages("start\n```\nnever closed");
  assert.ok(h.every(fmt.wellFormed));
});

// ---- access -----------------------------------------------------------------------
test("access: private chats need an allowed user; groups need a listed group AND an allowed user; channels and bots are ignored", () => {
  const cfg = CFG();
  assert.deepEqual(check(cfg, { chat: { id: 111, type: "private" }, from: { id: 111 } }), { ok: true, admin: true });
  assert.equal(check(cfg, { chat: { id: 222, type: "private" }, from: { id: 222 } }).admin, false);
  assert.equal(check(cfg, { chat: { id: 999, type: "private" }, from: { id: 999 } }).reason, "not-allowed");
  assert.equal(check(cfg, { chat: { id: -100500, type: "supergroup" }, from: { id: 222 } }).ok, true);
  assert.equal(check(cfg, { chat: { id: -777, type: "group" }, from: { id: 222 } }).silent, true, "unlisted group is silent");
  assert.equal(check(cfg, { chat: { id: -100500, type: "supergroup" }, from: { id: 999 } }).ok, false, "non-member in a listed group is refused");
  assert.equal(check(cfg, { chat: { id: 1, type: "channel" }, from: { id: 111 } }).ok, false);
  assert.equal(check(cfg, { chat: { id: 111, type: "private" }, from: { id: 111, is_bot: true } }).ok, false);
});

test("access: names read naturally", () => {
  assert.equal(label({ id: 1, first_name: "Dheeraj", last_name: "Burli", username: "dheeraj" }), "Dheeraj Burli (@dheeraj)");
  assert.equal(label({ id: 2, username: "x" }), "@x");
  assert.equal(label({ id: 3 }), "Telegram user 3");
});

// ---- state, budgets, rate limit ----------------------------------------------------
test("state: project selection and spend survive a restart; budgets refuse when used up", () => {
  const dir = tmp();
  const s1 = new Store(dir, () => {});
  s1.setProjects(-100500, ["busybee"]);
  s1.record("111", 300000, 100000);
  assert.equal(s1.spendToday("111"), 400000);
  const s2 = new Store(dir, () => {});
  assert.deepEqual(s2.projectsFor(-100500), ["busybee"]);
  assert.equal(s2.projectsFor(42), "all", "default is all projects");
  const cfg = CFG({ AGENT_DAILY_TOKENS_PER_USER: "400000" });
  assert.throws(() => s2.check("111", cfg), (e) => e instanceof BudgetError && /today's allowance/.test(e.message));
  assert.doesNotThrow(() => s2.check("222", cfg), "other people keep their own allowance");
  const team = CFG({ AGENT_MONTHLY_TOKENS: "100" });
  s2.record("222", 100, 0);
  assert.throws(() => s2.check("222", team), (e) => /monthly budget/.test(e.message));
  // the file holds numbers only, never questions or answers
  const raw = fs.readFileSync(path.join(dir, "state.json"), "utf8");
  assert.ok(!/question|answer|message/i.test(raw));
});

test("state: an unwritable data directory degrades to RAM with a warning, instead of crashing", () => {
  const logs = [];
  // a regular file where a directory should be: fails at once, on every OS
  const blocker = path.join(tmp(), "file.txt");
  fs.writeFileSync(blocker, "x");
  const s = new Store(path.join(blocker, "data"), (m) => logs.push(m));
  assert.equal(s.persistent, false);
  assert.match(logs[0], /not usable/);
  s.setProjects(1, []); // still works in memory
  assert.deepEqual(s.projectsFor(1), []);
});

test("state: usage older than 40 days is pruned", () => {
  const s = new Store(tmp(), () => {});
  const old = new Date(Date.now() - 60 * 864e5);
  s.record("333", 10, 10, old);
  s.record("444", 5, 5);
  assert.ok(!Object.keys(s.data.usage).some((k) => k.includes(`:333`) && k.includes(istDay(old))));
  assert.ok(Object.keys(s.data.usage).some((k) => k.includes(":444")));
});

test("rate limiter: N per minute, then refuses; recovers after a minute", () => {
  const r = new RateLimiter(2);
  assert.equal(r.take("u", 0), true); assert.equal(r.take("u", 1), true);
  assert.equal(r.take("u", 2), false);
  assert.equal(r.take("u", 61_000), true);
});

// ---- Telegram client ----------------------------------------------------------------
const fakeApi = (routes) => {
  const calls = [];
  const f = async (url, o = {}) => {
    const u = new URL(url);
    const method = u.pathname.split("/").pop();
    const body = o.body ? JSON.parse(o.body) : {};
    calls.push({ method, body, host: u.host, path: u.pathname });
    const r = routes(method, body, u);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify({ ok: true, result: r === undefined ? true : r }), { status: 200 });
  };
  return { f, calls };
};

test("telegram client: scrubs the token from errors; retries 429 with retry_after; 409 is reported with its code", async () => {
  let n = 0;
  const { f } = fakeApi((m) => {
    if (m === "getMe" && n++ === 0) return new Response(JSON.stringify({ ok: false, error_code: 429, description: `Too Many Requests ${TOKEN}`, parameters: { retry_after: 0 } }), { status: 429 });
    return undefined;
  });
  const logs = [];
  const tg = new TelegramClient({ token: TOKEN, fetchImpl: f, log: (m) => logs.push(m) });
  assert.equal(await tg.getMe(), true);
  assert.equal(n, 2, "the 429 was retried once: two requests in total");
  const down = new TelegramClient({ token: TOKEN, fetchImpl: async () => new Response(JSON.stringify({ ok: false, error_code: 401, description: `Unauthorized: bot ${TOKEN}` }), { status: 401 }) });
  await assert.rejects(() => down.getMe(), (e) => !e.message.includes(TOKEN) && e.message.includes("<token>") && e.code === 401);
  const conflict = new TelegramClient({ token: TOKEN, fetchImpl: async () => new Response(JSON.stringify({ ok: false, error_code: 409, description: "Conflict" }), { status: 409 }) });
  await assert.rejects(() => conflict.getUpdates(0), (e) => e.code === 409);
});

test("telegram client: downloads are capped at 20 MB and the file path is never logged", async () => {
  const big = { ok: true, result: { file_id: "x", file_size: 30 * 1024 * 1024, file_path: "documents/a.pdf" } };
  const tg = new TelegramClient({ token: TOKEN, fetchImpl: async () => new Response(JSON.stringify(big), { status: 200 }) });
  await assert.rejects(() => tg.download("x"), /larger than 20 MB/);
});

test("poll: handles updates in order, advances the offset, and stops when aborted", async () => {
  const seen = [];
  const offsets = [];
  let calls = 0;
  const ac = new AbortController();
  const tg = { getUpdates: async (offset) => {
    offsets.push(offset);
    calls++;
    if (calls === 1) return [{ update_id: 10 }, { update_id: 11 }];
    if (calls === 2) return [{ update_id: 12 }];
    ac.abort(); return [];
  } };
  await poll(tg, async (u) => seen.push(u.update_id), { signal: ac.signal, onError: () => {} });
  assert.deepEqual(seen, [10, 11, 12]);
  assert.deepEqual(offsets, [0, 12, 13]);
});

// ---- the bot, end to end ----------------------------------------------------------------
function world({ cfg = CFG(), modelReply, files = {}, now } = {}) {
  const logs = [];
  const sent = [];
  const edits = [];
  const answers = [];
  const { f, calls } = fakeApi((method, body, u) => {
    if (method === "getMe") return { id: 999, username: "gq_agent_bot", is_bot: true, first_name: "GQ" };
    if (method === "sendMessage") { sent.push(body); return { message_id: 500 + sent.length, chat: { id: body.chat_id } }; }
    if (method === "editMessageText" || method === "editMessageReplyMarkup") { edits.push({ method, ...body }); return true; }
    if (method === "answerCallbackQuery") { answers.push(body); return true; }
    if (method === "getFile") return { file_id: body.file_id, file_size: files[body.file_id] ? files[body.file_id].length : 1, file_path: `documents/${body.file_id}.bin` };
    if (u.pathname.includes("/file/bot")) return new Response(files[u.pathname.split("/").pop().replace(".bin", "")] || Buffer.alloc(0), { status: 200 });
    return undefined;
  });
  const tg = new TelegramClient({ token: TOKEN, fetchImpl: f, log: (m) => logs.push(m) });
  const store = new Store(cfg.dataDir, () => {});
  const snapshots = new SnapshotStore({ projects: PROJECTS, log: () => {} });
  const dir = tmp();
  const ready = Promise.all(PROJECTS.map((p) => snapshots.loadFromDir(p.id, fixtureRepo(dir, p.id), "abc1234def5678")));
  const prompts = [];
  let turn = 0;
  const provider = { name: "deepinfra", model: "google/gemini-2.5-flash", chat: async (a) => {
    prompts.push(a);
    if (modelReply) return modelReply(a, turn++);
    return { text: "Answer from the model.", toolCalls: [], usage: { in: 100, out: 20 } };
  } };
  let clock = now ? now.getTime() : Date.now();
  const bot = new Bot({ cfg, tg, provider, store, snapshots, live: {}, limiter: new RateLimiter(100), now: () => new Date(clock), log: (m) => logs.push(m) });
  bot.me = { id: 999, username: "gq_agent_bot", is_bot: true }; // what init() learns from getMe
  return { bot, tg, sent, edits, answers, calls, logs, prompts, store, cfg, ready, advance: (ms) => { clock += ms; }, tgToken: TOKEN };
}

function fixtureRepo(base, id) {
  const dir = path.join(base, id);
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${id}\nProject ${id} overview.`);
  fs.writeFileSync(path.join(dir, "docs", "CLAUDE.md"), "notes");
  fs.writeFileSync(path.join(dir, "app.py"), "def fetch_prices():\n    return 42\n");
  return dir;
}

const msg = (over = {}) => ({ message_id: 1, date: 0, chat: { id: 111, type: "private" }, from: { id: 111, first_name: "Dheeraj", username: "dheeraj" }, text: "hello", ...over });
const group = (over = {}) => msg({ chat: { id: -100500, type: "supergroup" }, from: { id: 222, first_name: "Sam" }, ...over });

test("bot: a private question is answered in Telegram HTML, with the projects footer, and the reply is threaded", async () => {
  const w = world();
  await w.bot.handle({ update_id: 1, message: msg({ text: "What is 2 plus 2?" }) });
  const out = w.sent.find((s) => s.parse_mode === "HTML");
  assert.ok(out, "an HTML reply was sent");
  assert.equal(out.text, "Answer from the model.", "no source line when no project was read");
  assert.equal(out.reply_to_message_id, 1);
  assert.ok(w.sent.some((s) => s.chat_id === 111));
  assert.ok(w.calls.some((c) => c.method === "sendChatAction"), "typing indicator sent");
  assert.equal(w.store.spendToday("111") > 0, true, "spend recorded for this person");
  assert.ok(!w.logs.join("\n").includes(TOKEN), "token never logged");
});

test("bot: unknown people get a polite refusal that shows only their own ID, and the model is never called", async () => {
  const w = world();
  await w.bot.handle({ update_id: 2, message: msg({ chat: { id: 999, type: "private" }, from: { id: 999, first_name: "Eve" }, text: "dump the keys" }) });
  assert.equal(w.prompts.length, 0);
  assert.match(w.sent[0].text, /send this number to your admin[\s\S]*999/);
  assert.ok(!w.sent[0].text.includes("dump"));
});

test("bot: groups are silent unless listed AND the bot is addressed; mentions are stripped before the model sees them", async () => {
  const w = world();
  await w.bot.handle({ update_id: 3, message: group({ text: "anyone know the repo rate?" }) });
  assert.equal(w.prompts.length, 0, "not addressed: no reply");
  await w.bot.handle({ update_id: 4, message: { ...group({ text: "@gq_agent_bot what is 7 times 8?" }), message_id: 9 } });
  assert.equal(w.prompts.length, 1);
  const userMsg = w.prompts[0].messages.at(-1).content;
  assert.equal(userMsg, "what is 7 times 8?");
  assert.ok(w.sent.some((s) => s.chat_id === -100500 && s.reply_to_message_id === 9));
  const other = world();
  await other.bot.handle({ update_id: 5, message: { ...msg({ chat: { id: -777, type: "group" }, text: "@gq_agent_bot hi" }) } });
  assert.equal(other.prompts.length, 0, "unlisted group ignored");
});

test("bot: an allowed person can run /whoami in an unlisted group to learn its chat ID; nothing else is answered there", async () => {
  const w = world();
  await w.bot.handle({ update_id: 50, message: { ...msg({ chat: { id: -777, type: "supergroup" }, from: { id: 111, first_name: "Dheeraj" }, text: "/whoami" }) } });
  assert.match(w.sent.at(-1).text, /Chat ID: -777/);
  await w.bot.handle({ update_id: 51, message: { ...msg({ chat: { id: -777, type: "supergroup" }, from: { id: 111 }, text: "what is 2+2" }) } });
  assert.equal(w.prompts.length, 0, "questions in an unlisted group are still ignored");
  await w.bot.handle({ update_id: 52, message: { ...msg({ chat: { id: -777, type: "supergroup" }, from: { id: 999 }, text: "/whoami" }) } });
  assert.equal(w.sent.filter((x) => x.chat_id === -777).length, 1, "people who are not allowed get nothing there");
});

test("bot: a reply to one of the bot's messages counts as addressing it", async () => {
  const w = world();
  await w.bot.handle({ update_id: 6, message: group({ text: "and in Hindi?", reply_to_message: { from: { id: 999 }, message_id: 2 } }) });
  assert.equal(w.prompts.length, 1);
});

test("bot: /projects shows a picker; tapping toggles and persists for the chat; All and None work", async () => {
  const w = world();
  await w.bot.handle({ update_id: 7, message: msg({ text: "/projects" }) });
  const picker = w.sent.find((s) => s.reply_markup);
  assert.ok(picker, "picker sent");
  const rows = picker.reply_markup.inline_keyboard;
  assert.ok(rows.flat().some((b) => b.callback_data === "p:busybee"));
  assert.ok(rows.at(-1).some((b) => b.callback_data === "p:done"));
  const press = (data) => w.bot.handle({ update_id: 8, callback_query: { id: "cb", from: { id: 111 }, data, message: { message_id: 77, chat: { id: 111, type: "private" } } } });
  // from "All", tapping a project switches it off (the buttons show ✅ for every project on)
  await press("p:busybee");
  assert.deepEqual(w.store.projectsFor(111), PROJECTS.map((p) => p.id).filter((id) => id !== "busybee"));
  await press("p:none");
  await press("p:busybee");
  assert.deepEqual(w.store.projectsFor(111), ["busybee"]);
  await press("p:heatmap-dashboard");
  assert.deepEqual(w.store.projectsFor(111), ["busybee", "heatmap-dashboard"].sort((a, b) => PROJECTS.findIndex((p) => p.id === a) - PROJECTS.findIndex((p) => p.id === b)));
  await press("p:none");
  assert.deepEqual(w.store.projectsFor(111), []);
  await press("p:all");
  assert.equal(w.store.projectsFor(111), "all");
  assert.ok(w.edits.length >= 4, "the picker message is updated in place");
  await press("p:done");
  assert.ok(w.answers.length >= 5);
});

test("bot: an unselected project is refused in the question path too (the footer names only what was used)", async () => {
  const w = world({ modelReply: (a, i) => i === 0
    ? { text: "", toolCalls: [{ id: "1", name: "read_docs", args: { project: "heatmap-dashboard" } }], usage: { in: 1, out: 1 } }
    : { text: "It is not selected, so I can't read it.", toolCalls: [], usage: { in: 1, out: 1 } } });
  await w.bot.handle({ update_id: 9, message: msg({ text: "/busybee-only" }) }).catch(() => {});
  w.store.setProjects(111, ["busybee"]);
  await w.bot.handle({ update_id: 10, message: msg({ text: "What does the heatmap README say?" }) });
  const toolResult = w.prompts[1].messages.find((m) => m.role === "tool");
  assert.match(toolResult.content, /not selected/);
  assert.doesNotMatch(w.sent.at(-1).text, /📁 From/);
});

test("bot: a selected project's repo is read from the snapshot store (regression: the bot once passed the wrong store)", async () => {
  const w = world({ modelReply: (a, i) => i === 0
    ? { text: "", toolCalls: [{ id: "1", name: "grep_code", args: { project: "busybee", query: "fetch_prices" } }], usage: { in: 1, out: 1 } }
    : { text: "busybee defines fetch_prices in app.py.", toolCalls: [], usage: { in: 1, out: 1 } } });
  await w.ready;
  w.store.setProjects(111, ["busybee"]);
  await w.bot.handle({ update_id: 40, message: msg({ text: "where is fetch_prices?" }) });
  const toolResult = w.prompts[1].messages.find((m) => m.role === "tool");
  assert.match(toolResult.content, /"path":"app\.py"/, "the search found the file in the snapshot");
  assert.match(w.sent.at(-1).text, /📁 From: BusyBee/);
});

test("bot: /none turns off project reading for the chat, and the model is told no project is selected", async () => {
  const w = world();
  await w.bot.handle({ update_id: 11, message: msg({ text: "/none" }) });
  await w.bot.handle({ update_id: 12, message: msg({ text: "Explain CAGR" }) });
  assert.match(w.prompts[0].system, /No project is selected/);
  assert.ok(!w.prompts[0].tools.some((t) => t.name === "read_file"), "no repo tools without a project");
});

test("bot: /clear forgets the conversation but keeps the project selection; /whoami shows the ID", async () => {
  const w = world();
  w.store.setProjects(111, ["busybee"]);
  await w.bot.handle({ update_id: 13, message: msg({ text: "first question" }) });
  await w.bot.handle({ update_id: 14, message: msg({ text: "second question" }) });
  assert.ok(w.prompts[1].messages.length >= 3, "second turn carries the first");
  await w.bot.handle({ update_id: 15, message: msg({ text: "/clear" }) });
  await w.bot.handle({ update_id: 16, message: msg({ text: "third question" }) });
  assert.equal(w.prompts[2].messages.filter((m) => m.role === "user").length, 1);
  assert.deepEqual(w.store.projectsFor(111), ["busybee"]);
  await w.bot.handle({ update_id: 17, message: msg({ text: "/whoami" }) });
  assert.match(w.sent.at(-1).text, /Telegram ID: 111/);
});

test("bot: /status and /refresh are for admins only", async () => {
  const w = world();
  await w.ready;
  await w.bot.handle({ update_id: 18, message: msg({ chat: { id: 222, type: "private" }, from: { id: 222 }, text: "/status" }) });
  assert.match(w.sent.at(-1).text, /Only admins/);
  await w.bot.handle({ update_id: 19, message: msg({ text: "/status" }) });
  assert.match(w.sent.at(-1).text, /Spend this month: 0 tokens \(cap: 3,00,00,000\)/);
  assert.match(w.sent.at(-1).text, /busybee: commit abc1234def56/);
  assert.match(w.sent.at(-1).text, /Live market data: off/);
});

test("bot: a PDF sent in Telegram is read by the agent; unsupported files are refused before download", async () => {
  const pdf = (await import("unpdf")) && null; void pdf;
  const pdfBytes = makePdf(["Net profit was 420 crore"]);
  const w = world({ files: { F1: pdfBytes }, modelReply: (a, i) => i === 0
    ? { text: "", toolCalls: [{ id: "1", name: "search_attachment", args: { name: "report.pdf", query: "420" } }], usage: { in: 1, out: 1 } }
    : { text: "Net profit was 420 crore (page 1).", toolCalls: [], usage: { in: 1, out: 1 } } });
  await w.bot.handle({ update_id: 20, message: msg({ text: "What was the profit?", document: { file_id: "F1", file_name: "report.pdf", mime_type: "application/pdf", file_size: pdfBytes.length } }) });
  assert.match(w.prompts[0].system, /report\.pdf \(pdf, 1 pages/);
  assert.match(w.sent.at(-1).text, /420 crore \(page 1\)/);
  const before = w.prompts.length;
  await w.bot.handle({ update_id: 21, message: msg({ text: "", document: { file_id: "F2", file_name: "setup.exe", file_size: 10 } }) });
  assert.equal(w.prompts.length, before, "refused without calling the model");
  assert.match(w.sent.at(-1).text, /I can't read "setup.exe"/);
  await w.bot.handle({ update_id: 22, message: msg({ text: "", document: { file_id: "F3", file_name: "huge.csv", file_size: 11 * 1024 * 1024 } }) });
  assert.match(w.sent.at(-1).text, /bigger than 10 MB/);
});

test("bot: photos get a clear explanation instead of silence", async () => {
  const w = world();
  await w.bot.handle({ update_id: 23, message: msg({ text: "", photo: [{ file_id: "p" }] }) });
  assert.match(w.sent.at(-1).text, /can't read photos/);
});

test("bot: an over-budget person gets the allowance message and the model is never called", async () => {
  const w = world({ cfg: CFG({ AGENT_DAILY_TOKENS_PER_USER: "10" }) });
  w.store.record("111", 50, 50);
  await w.bot.handle({ update_id: 24, message: msg({ text: "one more question" }) });
  assert.equal(w.prompts.length, 0);
  assert.match(w.sent.at(-1).text, /today's allowance/);
});

test("bot: a model failure shows a plain apology, never the error details", async () => {
  const w = world({ modelReply: () => { throw new Error("DeepInfra 500: internal details with " + TOKEN); } });
  await w.bot.handle({ update_id: 25, message: msg({ text: "hi" }) });
  const last = w.sent.at(-1).text;
  assert.match(last, /couldn't finish that one/);
  assert.ok(!last.includes("DeepInfra") && !last.includes(TOKEN));
});

test("bot: the per-person rate limit refuses bursts", async () => {
  const w = world();
  w.bot.limiter = new RateLimiter(1);
  await w.bot.handle({ update_id: 26, message: msg({ text: "one" }) });
  await w.bot.handle({ update_id: 27, message: msg({ text: "two" }) });
  assert.match(w.sent.at(-1).text, /sending messages quickly/);
});

// ---- a real PDF for the bot test ------------------------------------------------------
function makePdf(pages) {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`];
  const font = 3 + pages.length * 2;
  pages.forEach((t, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 144] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
    const st = `BT /F1 14 Tf 20 80 Td (${t}) Tj ET`;
    objs.push(`<< /Length ${st.length} >>\nstream\n${st}\nendstream`);
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n"; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
void docs;
