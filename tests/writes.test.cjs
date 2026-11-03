/** Confirm-first changes to project data, dashboard watchlists, audit log. `npm test` (no network). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dbwrite = require("../src/tools/dbwrite.js");
const { ProjectDb } = require("../src/projectdb.js");
const { buildTools } = require("../src/tools/index.js");
const { buildSystemPrompt } = require("../src/prompt.js");
const { Store, RateLimiter } = require("../src/state.js");
const { Bot } = require("../src/bot.js");
const { TelegramClient } = require("../src/telegram.js");
const { SnapshotStore } = require("../src/snapshots.js");
const { PROJECTS, IDS } = require("../src/projects.js");
const cfgMod = require("../src/config.js");

// ---- a small in-memory Supabase: select/insert/update/delete with filters, counts, unique keys, auth.admin
function memDb(tables, { unique = {}, authUsers = [] } = {}) {
  const log = [];
  const from = (table) => {
    const st = { op: "select", filters: [], head: false, vals: null, limit: null, sel: "*" };
    const run = () => {
      let rows = (tables[table] = tables[table] || []);
      const keep = (r) => st.filters.every(([m, c, v]) => {
        const x = r[c];
        if (m === "eq") return String(x) === String(v);
        if (m === "neq") return String(x) !== String(v);
        if (m === "in") return v.map(String).includes(String(x));
        if (m === "ilike") return String(x || "").toLowerCase().includes(String(v).replace(/%/g, "").toLowerCase());
        if (m === "gt") return x > v; if (m === "gte") return x >= v; if (m === "lt") return x < v; if (m === "lte") return x <= v;
        if (m === "is") return v === null ? x == null : x === v;
        return true;
      });
      const joined = (r) => (/instruments\(/.test(st.sel) ? { ...r, instruments: (tables.instruments || []).find((i) => i.id === r.instrument_id) || null } : r);
      if (st.op === "insert") {
        const list = Array.isArray(st.vals) ? st.vals : [st.vals];
        const made = [];
        for (const v of list) {
          const key = unique[table];
          if (key && rows.some((r) => key.every((k) => r[k] === v[k]))) { log.push(["insert-dup", table]); return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }; }
          const row = { id: `${table}-${rows.length + 1}`, ...v }; rows.push(row); made.push(row);
        }
        log.push(["insert", table, list]);
        return { data: made, error: null };
      }
      const hit = rows.filter(keep);
      if (st.op === "update") { hit.forEach((r) => Object.assign(r, st.vals)); log.push(["update", table, st.vals, hit.length]); return { data: hit, error: null }; }
      if (st.op === "delete") { tables[table] = rows.filter((r) => !keep(r)); log.push(["delete", table, hit.length]); return { data: hit, error: null }; }
      const out = hit.slice(0, st.limit == null ? 1000 : st.limit).map(joined);
      return { data: st.head ? null : out, count: hit.length, error: null };
    };
    const b = {};
    for (const m of ["eq", "neq", "gt", "gte", "lt", "lte", "ilike", "is", "in"]) b[m] = (c, v) => { st.filters.push([m, c, v]); return b; };
    b.select = (cols = "*", o = {}) => { st.sel = cols; if (o.head) st.head = true; return b; };
    b.insert = (v) => { st.op = "insert"; st.vals = v; return b; };
    b.update = (v) => { st.op = "update"; st.vals = v; return b; };
    b.delete = () => { st.op = "delete"; return b; };
    b.order = () => b; b.range = () => b;
    b.limit = (n) => { st.limit = n; return b; };
    b.single = async () => { const r = run(); return { data: (r.data || [])[0] || null, error: r.error }; };
    b.maybeSingle = b.single;
    b.then = (res, rej) => Promise.resolve(run()).then(res, rej);
    return b;
  };
  return { client: { from, auth: { admin: { listUsers: async () => ({ data: { users: authUsers }, error: null }) } } }, tables, log };
}
const openapi = (names) => async () => new Response(JSON.stringify({ definitions: Object.fromEntries(names.map(([n, cols]) => [n, { properties: Object.fromEntries(cols.map((c) => [c, {}])) }])) }));
const projectDb = (project, mem, defs) => new ProjectDb({ project, url: "https://x", key: "sb_secret_k", client: mem.client, fetchImpl: openapi(defs) });

const ME = { userId: "u1", name: "Dheeraj Burli", email: "dheeraj.burli@gquants.com", role: "admin", telegramId: "777", desks: [] };
const MEMBER = { ...ME, role: "member" };
const world = (member = ME) => {
  const fin = memDb({ alerts: [{ id: "a1", ticker: "TCS", status: "new" }, { id: "a2", ticker: "INFY", status: "new" }, { id: "a3", ticker: "WIT", status: "new" }], users: [{ id: "x", password_hash: "h" }] });
  const heat = memDb({
    instruments: [{ id: "i-tcs", symbol: "TCS", name: "Tata Consultancy Services", universe: "india_stocks", is_active: true }, { id: "i-tcsus", symbol: "TCS", name: "TCS Ltd US", universe: "us_stocks", is_active: true }, { id: "i-hdfc", symbol: "HDFCBANK", name: "HDFC Bank", universe: "india_stocks", is_active: true }],
    watchlists: [{ id: "w1", user_id: "auth-1", name: "watchlist 1" }, { id: "w2", user_id: "auth-1", name: "watchlist 2" }, { id: "w9", user_id: "auth-2", name: "someone else" }],
    watchlist_items: [],
  }, { unique: { watchlist_items: ["watchlist_id", "instrument_id"] }, authUsers: [{ id: "auth-1", email: "Dheeraj.Burli@gquants.com" }, { id: "auth-2", email: "other@gquants.com" }] });
  const dbs = {
    "gq-finxray-us": projectDb("gq-finxray-us", fin, [["alerts", ["id", "ticker", "status"]], ["users", ["id", "password_hash"]], ["app_secrets", ["id"]]]),
    "heatmap-dashboard": projectDb("heatmap-dashboard", heat, [["instruments", ["id", "symbol"]], ["watchlists", ["id"]]]),
    busybee: projectDb("busybee", memDb({}), [["tasks", ["id"]]]),
  };
  const pending = new dbwrite.PendingChanges();
  const audits = [];
  return { fin, heat, dbs, pending, ctx: { selected: IDS, projectDbs: dbs, member, pending, changeQueue: [], projectsUsed: new Set(), recordChange: (e) => audits.push(e) }, audits };
};
const change = (w, a) => dbwrite.projectChange.run({ project: "gq-finxray-us", table: "alerts", ...a }, w.ctx);

test("project_change: nothing is written when the tool runs; it queues a Confirm with an exact preview", async () => {
  const w = world();
  const r = await change(w, { action: "update", values: { status: "reviewed" }, where: [{ column: "ticker", op: "eq", value: "TCS" }], reason: "reviewed by Dheeraj" });
  assert.equal(r.status, "awaiting_confirmation");
  assert.match(r.will_change, /Change 1 row in gq-finxray-us › alerts where ticker eq "TCS"[\s\S]*"status":"reviewed"/);
  assert.match(r.note, /NOTHING has been changed yet/);
  assert.deepEqual(w.fin.log.filter((l) => l[0] !== "select"), [], "no write happened");
  assert.equal(w.ctx.changeQueue.length, 1);
  assert.equal(w.pending.peek(w.ctx.changeQueue[0]).count, 1);
});

test("project_change: confirmed changes run; the data is re-checked first, so a moved target is refused", async () => {
  const w = world();
  await change(w, { action: "update", values: { status: "reviewed" }, where: [{ column: "ticker", op: "eq", value: "TCS" }] });
  const p = w.pending.take(w.ctx.changeQueue[0]);
  const ok = await dbwrite.execute(p, w.dbs);
  assert.deepEqual(ok, { ok: true, rows: 1 });
  assert.equal(w.fin.tables.alerts.find((a) => a.id === "a1").status, "reviewed");
  assert.equal(w.fin.tables.alerts.find((a) => a.id === "a2").status, "new", "only the matching row");
  // a second proposal, then the data moves before the tap
  await change(w, { action: "update", values: { status: "x" }, where: [{ column: "status", op: "eq", value: "new" }] });
  const p2 = w.pending.take(w.ctx.changeQueue[1]);
  w.fin.tables.alerts.push({ id: "a4", ticker: "NEW", status: "new" });
  const bad = await dbwrite.execute(p2, w.dbs);
  assert.equal(bad.ok, false); assert.match(bad.error, /data changed since I checked[\s\S]*Nothing was changed/);
  assert.equal(w.fin.tables.alerts.filter((a) => a.status === "x").length, 0);
  const ins = await change(w, { action: "insert", values: [{ ticker: "ZEN", status: "new" }, { ticker: "ABC", status: "new" }] });
  assert.match(ins.will_change, /Add 2 rows to gq-finxray-us › alerts/);
  assert.deepEqual(await dbwrite.execute(w.pending.take(w.ctx.changeQueue[2]), w.dbs), { ok: true, rows: 2 });
});

test("project_change: guard rails (where required, columns checked, credentials, row limits, roles, BusyBee, strangers)", async () => {
  const w = world();
  assert.match((await change(w, { action: "update", values: { status: "x" } })).error, /needs a 'where'/);
  assert.match((await change(w, { action: "delete" })).error, /needs a 'where'/);
  assert.match((await change(w, { action: "update", values: { nope: 1 }, where: [{ column: "id", op: "eq", value: "a1" }] })).error, /not a column of alerts/);
  assert.match((await change(w, { action: "update", values: { status: "x" }, where: [{ column: "nope", op: "eq", value: 1 }] })).error, /not a column of alerts/);
  assert.match((await change(w, { action: "update", values: { status: "x" }, where: [{ column: "ticker", op: "eq", value: "ZZZ" }] })).error, /no rows match/);
  assert.match((await change(w, { table: "users", action: "update", values: { password_hash: "x" }, where: [{ column: "id", op: "eq", value: "x" }] })).error, /not a column|credential/);
  assert.match((await change(w, { table: "app_secrets", action: "delete", where: [{ column: "id", op: "eq", value: 1 }] })).error, /credentials/);
  assert.match((await change(w, { table: "nope", action: "insert", values: { a: 1 } })).error, /no table "nope"/);
  assert.match((await dbwrite.projectChange.run({ project: "busybee", table: "tasks", action: "delete", where: [] }, w.ctx)).error, /BusyBee has its own rules/);
  assert.match((await dbwrite.projectChange.run({ project: "gq-finxray-us", table: "alerts", action: "insert", values: { ticker: "A" } }, { ...w.ctx, member: null })).error, /team members only/);
  assert.match((await dbwrite.projectChange.run({ project: "gq-finxray-us", table: "alerts", action: "insert", values: { ticker: "A" } }, { ...w.ctx, selected: [] })).error, /not selected/);
  assert.match((await dbwrite.projectChange.run({ project: "gq-finxray-us", table: "alerts", action: "insert", values: { ticker: "A" } }, { ...w.ctx, pending: null })).error, /not available in this kind of run/);
  // roles: a plain member may change a few rows but not delete, nor touch more than 10
  const m = world(MEMBER);
  assert.equal((await change(m, { action: "update", values: { status: "x" }, where: [{ column: "ticker", op: "eq", value: "TCS" }] })).status, "awaiting_confirmation");
  const del = await change(m, { action: "delete", where: [{ column: "ticker", op: "eq", value: "TCS" }] });
  assert.match(del.error, /needs a BusyBee admin or supervisor, and your BusyBee role is member/); assert.equal(del.cannot, true);
  for (let i = 0; i < 12; i++) m.fin.tables.alerts.push({ id: `b${i}`, ticker: `B${i}`, status: "bulk" });
  assert.match((await change(m, { action: "update", values: { status: "y" }, where: [{ column: "status", op: "eq", value: "bulk" }] })).error, /more than 10 rows needs a BusyBee admin/);
  for (let i = 0; i < 120; i++) w.fin.tables.alerts.push({ id: `c${i}`, ticker: `C${i}`, status: "many" });
  assert.match((await change(w, { action: "update", values: { status: "y" }, where: [{ column: "status", op: "eq", value: "many" }] })).error, /120 rows; the limit is 100/);
  assert.equal((await change(w, { action: "delete", where: [{ column: "ticker", op: "eq", value: "TCS" }] })).status, "awaiting_confirmation");
  assert.match((await change(w, { action: "delete", where: [{ column: "ticker", op: "eq", value: "TCS" }] })).will_change, /DELETE 1 row[\s\S]*can't be undone/);
});

test("dashboard_watchlist: matched to the asker's own dashboard account by e-mail; add, duplicate, remove, create, list; never another person's lists", async () => {
  const w = world();
  const t = (a, ctx = w.ctx) => dbwrite.dashboardWatchlist.run(a, ctx);
  const amb = await t({ action: "add", instrument: "TCS", watchlist: "watchlist 1" });
  assert.match(amb.error, /more than one instrument/); assert.equal(amb.candidates.length, 2);
  const ok = await t({ action: "add", instrument: "TCS", universe: "india_stocks", watchlist: "watchlist 1" });
  assert.match(ok.done, /Added TCS \(Tata Consultancy Services, india_stocks\) to "watchlist 1"/);
  assert.deepEqual(w.heat.tables.watchlist_items, [{ id: "watchlist_items-1", watchlist_id: "w1", instrument_id: "i-tcs" }]);
  assert.match((await t({ action: "add", instrument: "TCS", universe: "india_stocks", watchlist: "watchlist 1" })).done, /already in/);
  assert.match((await t({ action: "add", instrument: "HDFC Bank" })).error, /more than one list/, "two lists and none named: ask");
  assert.match((await t({ action: "add", instrument: "HDFC Bank", watchlist: "someone else" })).error, /no list called/, "another user's list is invisible");
  assert.match((await t({ action: "add", instrument: "Zzzz", watchlist: "watchlist 2" })).error, /couldn't find/);
  const lst = await t({ action: "list" });
  assert.deepEqual(lst.lists.map((l) => l.name), ["watchlist 1", "watchlist 2"]); assert.match(lst.lists[0].stocks[0], /TCS \(Tata Consultancy Services\)/);
  assert.match((await t({ action: "remove", instrument: "TCS", universe: "india_stocks", watchlist: "watchlist 1" })).done, /Removed TCS/);
  assert.match((await t({ action: "remove", instrument: "TCS", universe: "india_stocks", watchlist: "watchlist 1" })).error, /isn't in/);
  assert.match((await t({ action: "create", name: "Banks" })).done, /Created the list "Banks"/);
  assert.match((await t({ action: "create", name: "banks" })).error, /already have/);
  assert.deepEqual(w.audits.map((a) => a.summary), ['added TCS to "watchlist 1"', 'removed TCS from "watchlist 1"', 'created watchlist "Banks"']);
  assert.match((await t({ action: "add", instrument: "TCS" }, { ...w.ctx, member: { ...ME, email: "stranger@gquants.com" } })).error, /no heatmap dashboard account for stranger@gquants.com/);
  assert.match((await t({ action: "list" }, { ...w.ctx, member: null })).error, /team members/);
  assert.match((await t({ action: "list" }, { ...w.ctx, selected: [] })).error, /not selected/);
});

test("registry: write tools only in live chats with the project selected and a database connected; never in scheduled runs", () => {
  const w = world();
  const names = (o) => buildTools({ selected: IDS, projectDbs: w.dbs, ...o }).map((t) => t.name);
  assert.ok(!names({}).includes("project_change"), "scheduled runs: no writes");
  assert.ok(!names({ taskTools: true }).includes("project_change"), "needs writeActions");
  const live = names({ taskTools: true, writeActions: true });
  assert.ok(live.includes("project_change") && live.includes("dashboard_watchlist"));
  const pc = buildTools({ selected: IDS, projectDbs: w.dbs, taskTools: true, writeActions: true }).find((t) => t.name === "project_change");
  assert.deepEqual(pc.parameters.properties.project.enum, ["heatmap-dashboard", "gq-finxray-us"], "BusyBee is not offered");
  assert.ok(!buildTools({ selected: ["busybee"], projectDbs: w.dbs, taskTools: true, writeActions: true }).some((t) => t.kind === "write"));
  const sys = buildSystemPrompt({ user: {}, selected: IDS, toolNames: ["project_change", "dashboard_watchlist", "busybee_create_task"] });
  assert.match(sys, /project_change proposes a change[\s\S]*does not run it/);
  assert.match(sys, /What you CAN change: BusyBee tasks[\s\S]*project_change[\s\S]*dashboard_watchlist/);
});

// ---- Telegram: Confirm / Cancel buttons, only the asker can tap, audit log, /changes
function botWorld() {
  const w = world();
  const cfg = cfgMod.load({ TELEGRAM_BOT_TOKEN: "1:x", DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "gqw-")), AGENT_RATE_PER_MIN: "100" });
  const calls = [];
  const f = async (url, o = {}) => { const method = new URL(url).pathname.split("/").pop(); const body = o.body ? JSON.parse(o.body) : {}; calls.push({ method, body }); return new Response(JSON.stringify({ ok: true, result: { message_id: 50 + calls.length } })); };
  const store = new Store(cfg.dataDir, () => {});
  let turn = 0;
  const provider = { name: "fake", model: "m", chat: async () => {
    turn++;
    return turn === 1
      ? { text: "", toolCalls: [{ id: "c1", name: "project_change", args: { project: "gq-finxray-us", table: "alerts", action: "update", values: { status: "reviewed" }, where: [{ column: "ticker", op: "eq", value: "TCS" }], reason: "asked by Dheeraj" } }], usage: { in: 1, out: 1 } }
      : { text: "I've prepared the change. Please tap Confirm; nothing has changed yet.", toolCalls: [], usage: { in: 1, out: 1 } };
  } };
  const bot = new Bot({ cfg, tg: new TelegramClient({ token: "1:x", fetchImpl: f, log: () => {} }), provider, engines: { deepinfra: provider, grok: null }, store, snapshots: new SnapshotStore({ projects: PROJECTS, log: () => {} }), live: {}, limiter: new RateLimiter(100), log: () => {}, projectDbs: w.dbs, team: { available: true, member: async (id) => (String(id) === "777" ? ME : null) } });
  bot.me = { id: 999, username: "gq_agent_bot" };
  return { bot, w, calls, store };
}
const dm = (id, text) => ({ update_id: Math.floor(Math.random() * 1e6), message: { message_id: 5, chat: { id, type: "private" }, from: { id, first_name: "D" }, text } });
const tap = (id, data) => ({ update_id: 9, callback_query: { id: "cb", from: { id }, data, message: { message_id: 88, chat: { id: 777, type: "private" }, text: "⚠️ Please confirm" } } });

test("telegram: a proposed change shows Confirm / Cancel; only the asker can confirm; nothing happens before the tap; the audit log records it", async () => {
  const t = botWorld();
  t.bot.cfg.busybeeAppUrl = ""; 
  await t.bot.handle(dm(777, "mark TCS alerts as reviewed in FinXray"));
  const ask = t.calls.filter((c) => c.method === "sendMessage").at(-1).body;
  assert.match(ask.text, /Please confirm this change[\s\S]*Change 1 row in gq-finxray-us › alerts[\s\S]*Why: asked by Dheeraj[\s\S]*Nothing has changed yet/);
  const [yes, no] = ask.reply_markup.inline_keyboard[0];
  assert.match(yes.callback_data, /^w:ok:[0-9a-f]{10}$/); assert.match(no.callback_data, /^w:no:/);
  assert.equal(t.w.fin.tables.alerts.find((a) => a.ticker === "TCS").status, "new", "still unchanged");
  await t.bot.handle(tap(555, yes.callback_data));
  assert.match(t.calls.filter((c) => c.method === "answerCallbackQuery").at(-1).body.text, /Only Dheeraj Burli can confirm/);
  assert.equal(t.w.fin.tables.alerts.find((a) => a.ticker === "TCS").status, "new");
  await t.bot.handle(tap(777, yes.callback_data));
  assert.equal(t.w.fin.tables.alerts.find((a) => a.ticker === "TCS").status, "reviewed");
  assert.match(t.calls.filter((c) => c.method === "editMessageText").at(-1).body.text, /✅ Done: changed 1 row in gq-finxray-us › alerts/);
  assert.equal(t.store.recentAudit(1)[0].ok, true);
  await t.bot.handle(tap(777, yes.callback_data));
  assert.match(t.calls.filter((c) => c.method === "answerCallbackQuery").at(-1).body.text, /expired/, "a confirm works once");
  await t.bot.handle(dm(777, "/changes"));
  assert.match(t.calls.filter((c) => c.method === "sendMessage").at(-1).body.text, /Recent changes made through me[\s\S]*Dheeraj Burli/);
});

test("telegram: Cancel leaves everything as it was", async () => {
  const t = botWorld();
  await t.bot.handle(dm(777, "mark TCS alerts as reviewed"));
  const ask = t.calls.filter((c) => c.method === "sendMessage").at(-1).body;
  await t.bot.handle(tap(777, ask.reply_markup.inline_keyboard[0][1].callback_data));
  assert.match(t.calls.filter((c) => c.method === "editMessageText").at(-1).body.text, /Cancelled\. Nothing was changed/);
  assert.equal(t.w.fin.tables.alerts.find((a) => a.ticker === "TCS").status, "new");
  assert.equal(t.store.recentAudit(5).length, 0);
});
