/** Scheduled monitoring tasks: schedules, the runner, in-chat tools and Telegram commands. `npm test` (no network). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const schedule = require("../src/schedule.js");
const { TaskRunner, buildRunPrompt, parseRunReply, seenKey } = require("../src/tasks.js");
const { Store, RateLimiter } = require("../src/state.js");
const { buildTools } = require("../src/tools/index.js");
const { Bot } = require("../src/bot.js");
const { TelegramClient } = require("../src/telegram.js");
const { SnapshotStore } = require("../src/snapshots.js");
const { PROJECTS, IDS } = require("../src/projects.js");
const { BudgetError } = require("../src/errors.js");
const cfgMod = require("../src/config.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gqt-"));
const IST = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h, mi) - 5.5 * 3600e3);
const CFG = (over = {}) => cfgMod.load({ TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_ALLOWED_USER_IDS: "111,222", TELEGRAM_ADMIN_USER_IDS: "111", TELEGRAM_ALLOWED_GROUP_IDS: "-100500", DATA_DIR: tmp(), AGENT_RATE_PER_MIN: "100", ...over });

// ---- schedules ------------------------------------------------------------------------
test("schedule: every accepted form parses and reads back clearly; bad ones explain why", () => {
  const ok = {
    "every 30m": "every 30 minutes", "every 2h": "every 2 hours", "hourly": "every hour", "every 3 hours": "every 3 hours",
    "daily 08:30": "daily at 08:30 IST", "every day 9:00, 15:30": "daily at 09:00, 15:30 IST", "daily at 8:30am": "daily at 08:30 IST",
    "weekdays 09:15": "weekdays at 09:15 IST", "weekends 10am": "weekends at 10:00 IST", "mon,wed,fri 09:00": "Mon, Wed, Fri at 09:00 IST",
    "weekly mon 09:00": "Mon at 09:00 IST", "Tue Thu 7pm": "Tue, Thu at 19:00 IST", "daily 12am": "daily at 00:00 IST", "daily 08:30 IST": "daily at 08:30 IST",
  };
  for (const [inp, out] of Object.entries(ok)) assert.equal(schedule.describe(schedule.parse(inp).spec), out, inp);
  // what we store is the description: it must parse back to the same schedule
  for (const out of Object.values(ok)) assert.equal(schedule.describe(schedule.parse(out).spec), out, `round trip: ${out}`);
  assert.equal(schedule.describe(schedule.parse("mon and thu 9am").spec), "Mon, Thu at 09:00 IST");
  for (const bad of ["every 5m", "daily 25:00", "daily 9", "weekly 9:00", "blah", "", "every 10 days", "funday 9:00"]) assert.ok(schedule.parse(bad).error, bad);
  assert.equal(schedule.parse("every 5m", { minMinutes: 5 }).spec.minutes, 5);
});

test("schedule: next run is computed in IST across days, weekends and intervals", () => {
  const monNoon = IST(2026, 11, 2, 12, 0); // Monday 12:00 IST
  const n = (s, from = monNoon, last = null) => schedule.fmtIst(schedule.nextRun(schedule.parse(s).spec, from, last));
  assert.equal(n("daily 08:30"), "03 Nov 08:30 IST");
  assert.equal(n("daily 09:00, 15:30"), "02 Nov 15:30 IST");
  assert.equal(n("weekends 10:00"), "07 Nov 10:00 IST");
  assert.equal(n("weekdays 09:15", IST(2026, 11, 6, 18, 0)), "09 Nov 09:15 IST", "Friday evening -> Monday");
  assert.equal(n("mon 09:00"), "09 Nov 09:00 IST", "already past today -> next week");
  assert.equal(n("daily 00:00", IST(2026, 11, 2, 23, 59)), "03 Nov 00:00 IST");
  assert.equal(schedule.nextRun(schedule.parse("every 2h").spec, monNoon).getTime(), monNoon.getTime(), "a new interval task is due now");
  assert.equal(n("every 2h", monNoon, IST(2026, 11, 2, 11, 0)), "02 Nov 13:00 IST");
  assert.equal(n("every 2h", monNoon, IST(2026, 11, 1, 9, 0)), "02 Nov 14:00 IST", "long downtime: no burst of catch-up runs");
});

// ---- prompt and reply parsing ------------------------------------------------------------
test("run prompt: first run covers a lookback window; later runs say since when and list what was already reported", () => {
  const t = { id: 4, title: "IT news", instruction: "Big news on TCS and Infosys", schedule: "every 2 hours", mode: "alerts", seen: [], lastRunAt: null };
  const first = buildRunPrompt(t, IST(2026, 11, 2, 12, 0));
  assert.match(first, /first run: cover roughly the last 24 hours/);
  assert.match(first, /Only report MATERIAL events/);
  assert.match(first, /TASK: Big news on TCS and Infosys/);
  assert.match(first, /NOTHING_NEW/);
  assert.match(first, /SEEN:/);
  const later = buildRunPrompt({ ...t, mode: "digest", lastRunAt: IST(2026, 11, 2, 10, 0).toISOString(), seen: ["https://a.example/1", "TCS Q2 results"] }, IST(2026, 11, 2, 12, 0));
  assert.match(later, /last run was at 02 Nov 10:00 IST/);
  assert.match(later, /- https:\/\/a\.example\/1\n- TCS Q2 results/);
  assert.match(later, /Report every new item/);
  assert.match(buildRunPrompt({ ...t, schedule: "Mon at 09:00 IST" }), /last 7 days/);
});

test("reply parsing: SEEN lines are hidden and collected; NOTHING_NEW in any common shape means nothing", () => {
  const r = parseRunReply("**TCS** wins deal\nDetails.\n\nSEEN: https://x.example/a\n- SEEN: `https://x.example/b`");
  assert.equal(r.body, "**TCS** wins deal\nDetails.");
  assert.deepEqual(r.seen, ["https://x.example/a", "https://x.example/b"]);
  assert.equal(r.nothing, false);
  for (const n of ["NOTHING_NEW", "NOTHING_NEW.", "**NOTHING_NEW**", "", "SEEN: x", "NOTHING_NEW (no fresh items since the last run)"]) assert.equal(parseRunReply(n).nothing, true, JSON.stringify(n));
  assert.equal(seenKey("https://X.example/a/?utm=1#x"), "https://x.example/a");
  assert.equal(seenKey("TCS Q2 results"), "tcs q2 results");
});

// ---- the runner -----------------------------------------------------------------------------
function runnerWorld({ replies, cfg = CFG(), allowed = () => true, postImpl } = {}) {
  const store = new Store(cfg.dataDir, () => {});
  const posts = [], prompts = [], logs = [];
  let i = 0;
  const provider = { name: "fake", model: "m", chat: async (a) => {
    prompts.push(a);
    const r = typeof replies === "function" ? replies(i++, a) : replies[Math.min(i++, replies.length - 1)];
    if (r instanceof Error) throw r;
    return { text: r, toolCalls: [], usage: { in: 100, out: 50 } };
  } };
  let clock = IST(2026, 11, 2, 12, 0).getTime();
  const runner = new TaskRunner({
    cfg, store, provider, snapshots: new SnapshotStore({ projects: PROJECTS, log: () => {} }), live: {}, liveOn: false, researchTool: null,
    isChatAllowed: allowed, log: (m) => logs.push(m), now: () => new Date(clock),
    post: postImpl || (async (chatId, md) => { posts.push({ chatId, md }); }),
  });
  return { runner, store, posts, prompts, logs, cfg, advance: (min) => { clock += min * 60e3; }, now: () => new Date(clock) };
}

test("runner: create validates the instruction, schedule and limits", () => {
  const w = runnerWorld({ replies: ["x"], cfg: CFG({ TASK_MAX_PER_CHAT: "2" }) });
  const mk = (over) => w.runner.create({ chatId: "-100500", createdBy: "111", instruction: "Big news on TCS and Infosys", scheduleText: "every 2h", ...over });
  assert.match(mk({ instruction: "x" }).error, /describe what the task/);
  assert.match(mk({ scheduleText: "every 5m" }).error, /15 minutes/);
  const a = mk({ title: "", mode: "alerts", projects: ["busybee"] }).task;
  assert.equal(a.id, 1); assert.equal(a.title, "Big news on TCS and Infosys"); assert.equal(a.mode, "alerts"); assert.deepEqual(a.projects, ["busybee"]);
  assert.equal(a.schedule, "every 2 hours");
  assert.equal(new Date(a.nextRunAt).getTime(), w.now().getTime(), "an interval task first runs straight away");
  mk({});
  assert.match(mk({}).error, /already has 2 tasks/);
  const daily = runnerWorld({ replies: ["x"] }).runner.create({ chatId: "1", createdBy: "1", instruction: "India macro news every morning", scheduleText: "daily 08:30" }).task;
  assert.match(schedule.fmtIst(daily.nextRunAt), /03 Nov 08:30/);
});

test("runner: a due task posts its update with a header, remembers what it reported, and the next run is told", async () => {
  const w = runnerWorld({ replies: ["**TCS** signs $1bn deal\nWhy it matters.\nSEEN: https://n.example/tcs-deal", "NOTHING_NEW\nSEEN: https://n.example/tcs-deal"] });
  const t = w.runner.create({ chatId: "-100500", createdBy: "111", instruction: "Big news on TCS", scheduleText: "every 2h" }).task;
  await Promise.all(w.runner.tick());
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0].chatId, "-100500");
  assert.match(w.posts[0].md, /^\*\*🔔 Big news on TCS\*\*\n\n\*\*TCS\*\* signs \$1bn deal/);
  assert.ok(!w.posts[0].md.includes("SEEN"), "SEEN lines are never posted");
  let s = w.store.getTask(t.id);
  assert.deepEqual(s.seen, ["https://n.example/tcs-deal"]);
  assert.equal(s.runs, 1); assert.equal(s.tokens, 150); assert.match(s.lastStatus, /posted/);
  assert.equal(schedule.fmtIst(s.nextRunAt), "02 Nov 14:00 IST");
  assert.equal(w.runner.tick().length, 0, "not due again yet");
  w.advance(121);
  await Promise.all(w.runner.tick());
  assert.match(w.prompts[1].messages.at(-1).content, /Already reported[\s\S]*https:\/\/n\.example\/tcs-deal/);
  assert.match(w.prompts[1].messages.at(-1).content, /last run was at 02 Nov 12:00 IST/);
  assert.equal(w.posts.length, 1, "nothing new: nothing posted");
  s = w.store.getTask(t.id);
  assert.equal(s.lastStatus, "nothing new");
  assert.equal(s.seen.length, 1, "the same item is not stored twice");
  assert.match(w.prompts[0].system, /running unattended/);
  assert.ok(!w.prompts[0].tools.some((x) => x.name === "schedule_task"), "a scheduled run can never create more tasks");
});

test("runner: a manual run posts 'nothing new' so the person sees it ran; it does not move the schedule", async () => {
  const w = runnerWorld({ replies: ["NOTHING_NEW"] });
  const t = w.runner.create({ chatId: "1", createdBy: "1", instruction: "India macro news please", scheduleText: "daily 08:30" }).task;
  const before = w.store.getTask(t.id).nextRunAt;
  await w.runner.run(t.id, { manual: true });
  assert.match(w.posts[0].md, /Nothing new since it was set up/);
  assert.equal(w.store.getTask(t.id).nextRunAt, before);
});

test("runner: never more than TASK_CONCURRENCY at once, and a running task is not started twice", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const w = runnerWorld({ cfg: CFG({ TASK_CONCURRENCY: "2" }), replies: () => "NOTHING_NEW" });
  w.runner.deps.provider = { name: "f", model: "m", chat: async () => { await gate; return { text: "NOTHING_NEW", toolCalls: [], usage: {} }; } };
  for (let i = 0; i < 4; i++) w.runner.create({ chatId: "1", createdBy: "1", instruction: `watch topic number ${i}`, scheduleText: "every 1h" });
  const first = w.runner.tick();
  assert.equal(first.length, 2);
  assert.equal(w.runner.tick().length, 0, "slots are full");
  release();
  await Promise.all(first);
  const second = w.runner.tick();
  assert.equal(second.length, 2, "the other two run next");
  await Promise.all(second);
});

test("runner: repeated failures pause the task and tell the chat; a budget stop does not count as a failure", async () => {
  const w = runnerWorld({ cfg: CFG({ TASK_MAX_FAILURES: "3" }), replies: () => new Error("DeepInfra 500") });
  const t = w.runner.create({ chatId: "-100500", createdBy: "111", instruction: "Big news on banks", scheduleText: "every 1h" }).task;
  for (let i = 0; i < 3; i++) { await w.runner.run(t.id); }
  const s = w.store.getTask(t.id);
  assert.equal(s.enabled, false);
  assert.match(w.posts.at(-1).md, /stopped after 3 failed tries[\s\S]*My updates/);
  const b = runnerWorld({ cfg: CFG({ TASK_MAX_FAILURES: "1" }), replies: () => new BudgetError("The team's monthly budget is used up.") });
  const bt = b.runner.create({ chatId: "1", createdBy: "1", instruction: "watch something important", scheduleText: "every 1h" }).task;
  await b.runner.run(bt.id);
  assert.equal(b.store.getTask(bt.id).enabled, true);
  assert.match(b.store.getTask(bt.id).lastStatus, /monthly budget/);
});

test("runner: a chat that is no longer allowed, or that blocks the bot, pauses its tasks", async () => {
  const w = runnerWorld({ replies: ["news\nSEEN: a"], allowed: () => false });
  const t = w.runner.create({ chatId: "-999", createdBy: "1", instruction: "watch something important", scheduleText: "every 1h" }).task;
  await w.runner.run(t.id);
  assert.equal(w.store.getTask(t.id).enabled, false);
  assert.match(w.store.getTask(t.id).lastStatus, /no longer allowed/);
  const k = runnerWorld({ replies: ["news\nSEEN: a"], postImpl: async () => { const e = new Error("bot was kicked"); e.code = 403; throw e; } });
  const kt = k.runner.create({ chatId: "-100500", createdBy: "1", instruction: "watch something important", scheduleText: "every 1h" }).task;
  await k.runner.run(kt.id);
  assert.equal(k.store.getTask(kt.id).enabled, false);
  assert.match(k.store.getTask(kt.id).lastStatus, /cannot post/);
});

test("runner: tasks survive a restart (same data directory)", () => {
  const cfg = CFG();
  const a = runnerWorld({ cfg, replies: ["x"] });
  a.runner.create({ chatId: "1", createdBy: "1", instruction: "watch something important", scheduleText: "daily 08:30" });
  const b = new Store(cfg.dataDir, () => {});
  assert.equal(b.listTasks().length, 1);
  assert.equal(b.listTasks()[0].instruction, "watch something important");
  assert.equal(b.addTask({ chatId: "1" }).id, 2, "ids keep counting after a restart");
});

// ---- in-chat tools -----------------------------------------------------------------------------
test("tools: schedule_task creates in this chat with the chat's projects; manage needs the creator or an admin", async () => {
  const w = runnerWorld({ replies: ["NOTHING_NEW"] });
  const tools = buildTools({ selected: [], taskTools: true });
  const t = (n) => tools.find((x) => x.name === n);
  const ctx = (userId, admin = false) => ({ task: { runner: w.runner, chatId: "-100500", userId, userLabel: `user ${userId}`, admin, chatProjects: ["busybee"] } });
  const c = await t("schedule_task").run({ instruction: "Every morning: India macro news on RBI, inflation and GDP", schedule: "weekdays 09:15", title: "India macro", mode: "digest" }, ctx("222"));
  assert.equal(c.created.id, 1); assert.equal(c.created.schedule, "weekdays at 09:15 IST");
  assert.equal(c.created.projects, "none", "default: no project code for news monitoring (busybee is not the market data)");
  const withCode = await t("schedule_task").run({ instruction: "Weekly summary of BusyBee code changes", schedule: "mon 09:00", projects: "current" }, ctx("222"));
  assert.deepEqual(withCode.created.projects, ["busybee"]);
  w.store.deleteTask(withCode.created.id);
  const liveCtx = { task: { ...ctx("222").task, chatProjects: ["heatmap-dashboard", "busybee"] } };
  const live = await t("schedule_task").run({ instruction: "Daily moves in our watchlist sectors", schedule: "daily 16:30" }, liveCtx);
  assert.deepEqual(live.created.projects, ["heatmap-dashboard"], "auto keeps only the live market data");
  w.store.deleteTask(live.created.id);
  assert.match((await t("schedule_task").run({ instruction: "x y z watch", schedule: "every 1m" }, ctx("222"))).error, /15 minutes/);
  assert.match((await t("schedule_task").run({ instruction: "watch something big", schedule: "daily 9:00", projects: "nope" }, ctx("222"))).error, /unknown project/);
  assert.deepEqual((await t("schedule_task").run({ instruction: "watch something big", schedule: "daily 9:00", projects: "all" }, ctx("222"))).created.projects, IDS);
  const list = await t("list_scheduled_tasks").run({}, ctx("222"));
  assert.equal(list.count, 2); assert.equal(list.tasks[0].instruction, undefined);
  assert.deepEqual(list.tasks.map((x) => x.id), [1, 4]);
  assert.match((await t("manage_scheduled_task").run({ id: 1, action: "pause" }, ctx("333"))).error, /only the person who created/);
  assert.equal((await t("manage_scheduled_task").run({ id: 1, action: "pause" }, ctx("222"))).done.enabled, false);
  assert.equal((await t("manage_scheduled_task").run({ id: 1, action: "resume" }, ctx("111", true))).done.enabled, true, "admins can change anyone's task");
  assert.equal((await t("manage_scheduled_task").run({ id: 1, action: "reschedule", schedule: "every 4h" }, ctx("222"))).done.schedule, "every 4 hours");
  assert.match((await t("manage_scheduled_task").run({ id: 1, action: "edit", instruction: "New brief: RBI only" }, ctx("222"))).done.instruction, /RBI only/);
  const other = { task: { ...ctx("222").task, chatId: "-200" } };
  assert.match((await t("manage_scheduled_task").run({ id: 1, action: "delete" }, other)).error, /no task #1 in this chat/, "tasks are per chat");
  assert.match((await t("manage_scheduled_task").run({ id: 1, action: "delete" }, ctx("222"))).done, /deleted/);
  assert.equal(w.store.listTasks().length, 1);
});

// ---- Telegram ------------------------------------------------------------------------------------
function botWorld({ modelReply } = {}) {
  const cfg = CFG();
  const sent = [];
  const f = async (url, o = {}) => {
    const method = new URL(url).pathname.split("/").pop();
    const body = o.body ? JSON.parse(o.body) : {};
    if (method === "sendMessage") sent.push(body);
    return new Response(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: 900 + sent.length } : true }), { status: 200 });
  };
  const tg = new TelegramClient({ token: "1:x", fetchImpl: f, log: () => {} });
  const store = new Store(cfg.dataDir, () => {});
  const prompts = [];
  let n = 0;
  const provider = { name: "fake", model: "m", chat: async (a) => { prompts.push(a); return modelReply ? modelReply(a, n++) : { text: "ok", toolCalls: [], usage: { in: 1, out: 1 } }; } };
  const snapshots = new SnapshotStore({ projects: PROJECTS, log: () => {} });
  const bot = new Bot({ cfg, tg, provider, store, snapshots, live: {}, limiter: new RateLimiter(100), log: () => {} });
  bot.me = { id: 999, username: "gq_agent_bot" };
  const posts = [];
  bot.runner = new TaskRunner({ cfg, store, provider, snapshots, live: {}, isChatAllowed: () => true, log: () => {}, post: async (c, md) => posts.push({ c, md }) });
  return { bot, sent, store, prompts, posts };
}
const msg = (text, over = {}) => ({ message_id: 5, chat: { id: -100500, type: "supergroup" }, from: { id: 222, first_name: "Sam" }, text, ...over });

test("telegram: /task add, /tasks, /task show; others can't change it, its creator and admins can", async () => {
  const w = botWorld();
  await w.bot.handle({ update_id: 1, message: msg("/task add weekdays 09:15 alerts | Big news on TCS, Infosys, HCL and Wipro") });
  assert.match(w.sent.at(-1).text, /Task #1 created: Big news on TCS, Infosys, HCL and Wipro\nRuns weekdays at 09:15 IST \(alerts/);
  assert.deepEqual(w.store.getTask(1).projects, ["heatmap-dashboard"], "the chat reads all projects; the task keeps only the market data");
  assert.equal(w.store.getTask(1).mode, "alerts");
  await w.bot.handle({ update_id: 2, message: msg("/tasks") });
  assert.match(w.sent.at(-1).text, /1\. Big news on TCS[\s\S]*Every weekday at 09:15 · next: /);
  assert.deepEqual(w.sent.at(-1).reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["t:run:1", "t:pause:1", "t:del:1"], "the creator gets run, pause and remove buttons");
  await w.bot.handle({ update_id: 3, message: msg("/task show 1") });
  assert.match(w.sent.at(-1).text, /Instruction:\nBig news on TCS/);
  await w.bot.handle({ update_id: 4, message: msg("/task pause 1", { from: { id: 333 } }) });
  // 333 is not an allowed user at all: ignored silently in the group
  await w.bot.handle({ update_id: 5, message: msg("/task delete 1", { from: { id: 111, first_name: "Dheeraj" } }) });
  assert.match(w.sent.at(-1).text, /Task #1 deleted/, "admin can delete");
  await w.bot.handle({ update_id: 6, message: msg("/task add daily 08:30 | India macro news: RBI, inflation") });
  await w.bot.handle({ update_id: 7, message: msg("/task schedule 2 every 3h") });
  assert.match(w.sent.at(-1).text, /now runs every 3 hours/);
  await w.bot.handle({ update_id: 8, message: msg("/task edit 2 | India and US macro news") });
  assert.equal(w.store.getTask(2).instruction, "India and US macro news");
  await w.bot.handle({ update_id: 9, message: msg("/task add every 2m | too often") });
  assert.match(w.sent.at(-1).text, /Couldn't create the task: the shortest interval/);
  await w.bot.handle({ update_id: 10, message: msg("/task add daily 09:00 no bar here") });
  assert.match(w.sent.at(-1).text, /Use: \/task add/);
});

test("telegram: /task pause by someone allowed who did not create it is refused", async () => {
  const w = botWorld();
  await w.bot.handle({ update_id: 1, message: msg("/task add daily 08:30 | India macro news daily", { from: { id: 111, first_name: "Admin" } }) });
  await w.bot.handle({ update_id: 2, message: msg("/task pause 1", { from: { id: 222 } }) });
  assert.match(w.sent.at(-1).text, /Only the person who created task #1 or an admin/);
  assert.equal(w.store.getTask(1).enabled, true);
});

test("telegram: plain words create a task through the agent, scoped to this chat and this person", async () => {
  const w = botWorld({ modelReply: (a, i) => i === 0
    ? { text: "", toolCalls: [{ id: "c1", name: "schedule_task", args: { instruction: "Each weekday morning, report India macro news: RBI policy, inflation, GDP, rupee, bond yields.", schedule: "weekdays 09:00", title: "India macro" } }], usage: { in: 1, out: 1 } }
    : { text: "Done: task #1 runs weekdays at 09:00 IST.", toolCalls: [], usage: { in: 1, out: 1 } } });
  await w.bot.handle({ update_id: 1, message: msg("@gq_agent_bot har weekday subah 9 baje India macro news bhejna") });
  assert.ok(w.prompts[0].tools.some((t) => t.name === "schedule_task"), "offered in a live chat");
  assert.match(w.prompts[0].system, /create it with schedule_task/);
  const t = w.store.getTask(1);
  assert.equal(t.chatId, "-100500"); assert.equal(t.createdBy, "222"); assert.equal(t.schedule, "weekdays at 09:00 IST");
  assert.match(w.sent.at(-1).text, /task #1/);
});

test("telegram: replying to a task update gives the agent that update as context", async () => {
  const w = botWorld();
  await w.bot.handle({ update_id: 1, message: msg("why does this matter for us?", { reply_to_message: { from: { id: 999 }, message_id: 77, text: "🔔 #3 · IT news\nTCS signs a $1bn deal with a UK insurer." } }) });
  const q = w.prompts[0].messages.at(-1).content;
  assert.match(q, /Replying to this earlier message:\n"""\n🔔 #3 · IT news\nTCS signs a \$1bn deal/);
  assert.match(q, /why does this matter for us\?$/);
});

test("config: spend caps default to none (pay as you go), and a cap of 0 never blocks", () => {
  const c = cfgMod.load({});
  assert.equal(c.dailyTokensPerUser, 0); assert.equal(c.monthlyTokensGlobal, 0);
  const s = new Store(tmp(), () => {});
  s.record("u", 1e9, 1e9);
  assert.doesNotThrow(() => s.check("u", c));
  assert.equal(c.taskMinIntervalMinutes, 15); assert.equal(c.taskConcurrency, 3); assert.equal(c.tasksEnabled, true);
  assert.equal(cfgMod.load({ TASKS_ENABLED: "false" }).tasksEnabled, false);
});
