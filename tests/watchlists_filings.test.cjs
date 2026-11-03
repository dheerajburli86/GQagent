/** Watchlists (holdings lists) and company filings (NSE, BSE, SEC). `npm test` (no network, no keys). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Store, RateLimiter } = require("../src/state.js");
const { buildTools } = require("../src/tools/index.js");
const watchlists = require("../src/tools/watchlists.js");
const filings = require("../src/tools/filings.js");
const { buildRunPrompt, executeTask, TaskRunner } = require("../src/tasks.js");
const { buildSystemPrompt } = require("../src/prompt.js");
const { Bot } = require("../src/bot.js");
const { TelegramClient } = require("../src/telegram.js");
const { SnapshotStore } = require("../src/snapshots.js");
const { PROJECTS, IDS } = require("../src/projects.js");
const cfgMod = require("../src/config.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gqw-"));
const CFG = (over = {}) => cfgMod.load({ TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_ALLOWED_USER_IDS: "111,222", TELEGRAM_ADMIN_USER_IDS: "111", TELEGRAM_ALLOWED_GROUP_IDS: "-100500", DATA_DIR: tmp(), AGENT_RATE_PER_MIN: "100", ...over });
const json = (j, status = 200, headers = {}) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json", ...headers } });
const text = (t, status = 200) => new Response(t, { status });
const NOW = new Date("2026-11-02T06:00:00Z");

// ---- store ---------------------------------------------------------------------------------------
test("watchlists: create, add (no duplicates, any case), remove, set, describe, delete; names are validated; saved to disk", () => {
  const dir = tmp();
  const s = new Store(dir, () => {});
  const c = s.editList("create", "India Holdings", { items: "HDFC Bank (NSE: HDFCBANK), Infosys (NSE: INFY)", description: "What we hold in India", by: "Dheeraj" });
  assert.equal(c.list.name, "india-holdings");
  assert.deepEqual(c.list.items, ["HDFC Bank (NSE: HDFCBANK)", "Infosys (NSE: INFY)"]);
  s.editList("add", "india-holdings", { items: ["infosys (nse: infy)", "TCS (NSE: TCS)"] });
  assert.deepEqual(s.getList("india-holdings").items, ["HDFC Bank (NSE: HDFCBANK)", "Infosys (NSE: INFY)", "TCS (NSE: TCS)"]);
  const r = s.editList("remove", "INDIA-HOLDINGS", { items: "tcs (nse: tcs); Wipro" });
  assert.deepEqual(r.not_found, ["Wipro"]);
  assert.equal(r.list.items.length, 2);
  s.editList("set", "india-holdings", { items: "Reliance Industries (NSE: RELIANCE)" });
  assert.deepEqual(s.getList("india-holdings").items, ["Reliance Industries (NSE: RELIANCE)"]);
  s.editList("describe", "india-holdings", { description: "Core India book" });
  assert.equal(s.getList("india-holdings").description, "Core India book");
  assert.match(s.editList("add", "bad name!", { items: "x" }).error, /list names/);
  assert.match(s.editList("remove", "nope", { items: "x" }).error, /no list "nope"/);
  s.editList("add", "global-holdings", { items: "ASML (NASDAQ: ASML)" });
  const again = new Store(dir, () => {});
  assert.deepEqual(again.lists().map((l) => l.name), ["global-holdings", "india-holdings"], "kept across restarts");
  assert.deepEqual(again.editList("delete", "global-holdings"), { deleted: "global-holdings" });
  assert.equal(again.getList("global-holdings"), null);
});

// ---- tools ---------------------------------------------------------------------------------------
test("watchlists tool: read anywhere; edit only for admins in a live chat", async () => {
  const s = new Store(tmp(), () => {});
  assert.match((await watchlists.readTool.run({}, { lists: s })).note, /No stock lists/);
  s.editList("create", "india-holdings", { items: "HDFC Bank (NSE: HDFCBANK)" });
  assert.equal((await watchlists.readTool.run({}, { lists: s })).lists[0].count, 1);
  assert.deepEqual((await watchlists.readTool.run({ name: "India-Holdings" }, { lists: s })).items, ["HDFC Bank (NSE: HDFCBANK)"]);
  assert.deepEqual((await watchlists.readTool.run({ name: "x" }, { lists: s })).lists, ["india-holdings"]);

  const names = (o) => buildTools({ selected: IDS, ...o }).map((t) => t.name);
  assert.ok(names({}).includes("watchlists") && names({}).includes("company_filings"));
  assert.ok(!names({ user: { isAdmin: true } }).includes("edit_watchlist"), "never outside a live chat (scheduled runs)");
  assert.ok(!names({ user: { isAdmin: false }, taskTools: true }).includes("edit_watchlist"), "not offered to non-admins");
  assert.ok(names({ user: { isAdmin: true }, taskTools: true }).includes("edit_watchlist"));

  const ctx = (admin) => ({ lists: s, task: { admin, userLabel: "Dheeraj" } });
  assert.match((await watchlists.editTool.run({ action: "add", name: "india-holdings", items: ["Infosys"] }, ctx(false))).error, /only admins/);
  assert.match((await watchlists.editTool.run({ action: "add", name: "india-holdings", items: ["Infosys"] }, { lists: s })).error, /live chat/);
  const done = await watchlists.editTool.run({ action: "add", name: "india-holdings", items: ["Infosys (NSE: INFY)"] }, ctx(true));
  assert.equal(done.done.count, 2);
  assert.equal(s.getList("india-holdings").updatedBy, "Dheeraj");
});

test("prompts: chat and scheduled runs are told to read watchlists for 'our holdings' and to check company filings", () => {
  const sys = buildSystemPrompt({ user: {}, selected: [], toolNames: ["watchlists", "company_filings", "edit_watchlist"] });
  assert.match(sys, /watchlists holds the team's saved lists/);
  assert.match(sys, /edit_watchlist changes a list/);
  assert.match(sys, /company_filings for what a company itself disclosed/);
  assert.doesNotMatch(buildSystemPrompt({ user: {}, selected: [], toolNames: ["watchlists"] }), /edit_watchlist changes/);
  const p = buildRunPrompt({ id: 3, title: "Holdings news", schedule: "daily at 09:00 IST", mode: "digest", instruction: "News on our India holdings", seen: [] }, NOW);
  assert.match(p, /call watchlists FIRST/);
  assert.match(p, /company_filings over the same window/);
});

test("scheduled run: the task reads the CURRENT watchlist, so editing the list changes what the task covers", async () => {
  const cfg = CFG();
  const store = new Store(cfg.dataDir, () => {});
  store.editList("create", "india-holdings", { items: "HDFC Bank (NSE: HDFCBANK)" });
  let seenByModel = null;
  const provider = {
    name: "fake", model: "m",
    chat: async (a) => {
      const last = a.messages.at(-1);
      if (last.role === "tool") { seenByModel = last.content; return { text: "NOTHING_NEW", toolCalls: [], usage: { in: 1, out: 1 } }; }
      assert.ok(a.tools.some((t) => t.name === "watchlists") && !a.tools.some((t) => t.name === "edit_watchlist"));
      return { text: "", toolCalls: [{ id: "c1", name: "watchlists", args: { name: "india-holdings" } }], usage: { in: 1, out: 1 } };
    },
  };
  const task = { id: 1, title: "t", schedule: "daily at 09:00 IST", mode: "digest", instruction: "News on our India holdings", projects: [], seen: [] };
  store.editList("add", "india-holdings", { items: "Infosys (NSE: INFY)" });
  const r = await executeTask(task, { provider, cfg, store, snapshots: new SnapshotStore({ projects: PROJECTS, log: () => {} }) }, NOW);
  assert.equal(r.nothing, true);
  assert.match(String(seenByModel), /Infosys \(NSE: INFY\)/);
});

// ---- Telegram ------------------------------------------------------------------------------------
function botWorld() {
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
  const provider = { name: "fake", model: "m", chat: async () => ({ text: "ok", toolCalls: [], usage: { in: 1, out: 1 } }) };
  const snapshots = new SnapshotStore({ projects: PROJECTS, log: () => {} });
  const bot = new Bot({ cfg, tg, provider, store, snapshots, live: {}, limiter: new RateLimiter(100), log: () => {} });
  bot.me = { id: 999, username: "gq_agent_bot" };
  bot.runner = new TaskRunner({ cfg, store, provider, snapshots, live: {}, isChatAllowed: () => true, log: () => {}, post: async () => {} });
  return { bot, sent, store };
}
const msg = (t, from = { id: 111, first_name: "Dheeraj" }) => ({ message_id: 5, chat: { id: -100500, type: "supergroup" }, from, text: t });

test("telegram: /list create, add, remove; /lists and /list <name>; only admins change lists", async () => {
  const w = botWorld();
  let u = 0;
  const say = (t, from) => w.bot.handle({ update_id: ++u, message: msg(t, from) });
  await say("/lists");
  assert.match(w.sent.at(-1).text, /No stock lists saved yet[\s\S]*just telling me/);
  await say("/list create india-holdings | What we hold in India");
  assert.match(w.sent.at(-1).text, /Created:\nindia-holdings \(0\) - What we hold in India/);
  await say("/list add india-holdings HDFC Bank (NSE: HDFCBANK), Infosys (NSE: INFY), TCS (NSE: TCS)");
  assert.match(w.sent.at(-1).text, /india-holdings \(3\)[\s\S]*• TCS \(NSE: TCS\)/);
  await say("/list remove india-holdings TCS (NSE: TCS), Wipro");
  assert.match(w.sent.at(-1).text, /\(2\)[\s\S]*Not in the list: Wipro/);
  await say("/list create global-holdings ASML (NASDAQ: ASML), TSMC (NYSE: TSM) | Global book");
  assert.deepEqual(w.store.getList("global-holdings").items, ["ASML (NASDAQ: ASML)", "TSMC (NYSE: TSM)"]);
  await say("/lists");
  assert.match(w.sent.at(-1).text, /Global holdings \(Global book\)\n  • ASML[\s\S]*India holdings \(What we hold in India\)/);
  await say("/list india-holdings", { id: 222, first_name: "Sam" });
  assert.match(w.sent.at(-1).text, /• HDFC Bank \(NSE: HDFCBANK\)/, "anyone allowed can read");
  await say("/list add india-holdings Wipro", { id: 222, first_name: "Sam" });
  assert.match(w.sent.at(-1).text, /Only admins/);
  assert.equal(w.store.getList("india-holdings").items.length, 2);
  await say("/list add india-holdings");
  assert.match(w.sent.at(-1).text, /Give the items/);
  await say("/list delete global-holdings");
  assert.match(w.sent.at(-1).text, /deleted/);
  await say("/list help");
  assert.match(w.sent.at(-1).text, /\/list set <name>/);
});

// ---- filings: India ------------------------------------------------------------------------------
test("filings india: NSE (cookie warm-up, name lookup), concall filter, PDF links, newest window", async () => {
  filings._reset();
  const calls = [];
  const f = async (url, o) => {
    calls.push({ url, cookie: o.headers.cookie });
    if (url === "https://www.nseindia.com/") return new Response("<html>", { headers: { "set-cookie": "nsit=abc; Path=/; HttpOnly" } });
    if (url.includes("/api/search/autocomplete")) return json({ symbols: [{ symbol: "HDFCBANK", symbol_info: "HDFC Bank Limited", result_sub_type: "equity" }] });
    if (url.includes("/api/corporate-announcements")) {
      assert.match(url, /symbol=HDFCBANK&from_date=03-10-2026&to_date=02-11-2026/);
      return json([
        { desc: "Analysts/Institutional Investor Meet/Con. Call Updates", attchmntText: "Transcript of the earnings call held on October 20, 2026", attchmntFile: "https://nsearchives.nseindia.com/corporate/HDFCBANK_t.pdf", an_dt: "28-Oct-2026 19:01:02" },
        { desc: "Financial Result Updates", attchmntText: "Unaudited results for Q2 FY27", attchmntFile: "https://nsearchives.nseindia.com/corporate/HDFCBANK_r.pdf", an_dt: "18-Oct-2026 16:10:00" },
      ]);
    }
    throw new Error(`unexpected ${url}`);
  };
  const r = await filings.tool.run({ market: "india", company: "HDFC Bank", category: "concall" }, { fetch: f, now: () => NOW });
  assert.equal(r.exchange, "NSE");
  assert.equal(r.symbol, "HDFCBANK");
  assert.equal(r.company, "HDFC Bank Limited");
  assert.equal(r.matched, 1);
  assert.deepEqual(r.items[0], { date: "28-Oct-2026 19:01:02", subject: "Analysts/Institutional Investor Meet/Con. Call Updates", details: "Transcript of the earnings call held on October 20, 2026", pdf: "https://nsearchives.nseindia.com/corporate/HDFCBANK_t.pdf" });
  assert.equal(calls.find((c) => c.url.includes("corporate-announcements")).cookie, "nsit=abc", "NSE cookies are sent");
  const all = await filings.tool.run({ market: "india", company: "HDFCBANK" }, { fetch: f, now: () => NOW });
  assert.equal(all.shown, 2);
  assert.equal(calls.filter((c) => c.url === "https://www.nseindia.com/").length, 1, "cookie reused");
  assert.equal(calls.filter((c) => c.url.includes("autocomplete")).length, 1, "a symbol is used as is");
});

test("filings india: NSE refuses -> BSE (scrip lookup, attachment URLs); both refuse -> a clear error with the fallback", async () => {
  filings._reset();
  const f = async (url) => {
    if (url.includes("nseindia.com")) return text("Access Denied", 403);
    if (url.includes("getQouteSearch")) return text("<li class='quotemenu'><a href='#'><strong>VALIANT COMMUNICATIONS LTD</strong> 526775</a></li>");
    if (url.includes("AnnSubCategoryGetData")) {
      assert.match(url, /strScrip=526775/);
      return json({ Table: [{ NEWSSUB: "Outcome of Board Meeting", HEADLINE: "Board approved Q2 results", NEWS_DT: "2026-10-30T17:02:00", CATEGORYNAME: "Board Meeting", ATTACHMENTNAME: "abc.pdf", SLONGNAME: "Valiant Communications Ltd" }] });
    }
    throw new Error(url);
  };
  const r = await filings.tool.run({ market: "india", company: "Valiant Communications", category: "results" }, { fetch: f, now: () => NOW });
  assert.equal(r.exchange, "BSE");
  assert.equal(r.scrip_code, "526775");
  assert.equal(r.items[0].pdf, "https://www.bseindia.com/xml-data/corpfiling/AttachLive/abc.pdf");
  assert.equal(r.items[0].category, "Board Meeting");

  filings._reset();
  const down = async () => text("no", 503);
  const e = await filings.tool.run({ market: "india", company: "TCS" }, { fetch: down, now: () => NOW });
  assert.match(e.error, /NSE: HTTP 503[\s\S]*BSE: HTTP 503/);
  assert.match(e.hint, /web_research/);
  assert.match((await filings.tool.run({ market: "japan", company: "Toyota" }, { fetch: down })).error, /india or us/);
});

// ---- filings: US ---------------------------------------------------------------------------------
test("filings us: ticker -> CIK, filings in the window with document URLs, form filter, and reported financials", async () => {
  filings._reset();
  const uas = new Set();
  const f = async (url, o) => {
    uas.add(o.headers["user-agent"]);
    if (url.endsWith("company_tickers.json")) return json({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." }, 1: { cik_str: 1045810, ticker: "NVDA", title: "NVIDIA CORP" } });
    if (url.includes("/submissions/CIK0001045810.json")) return json({
      name: "NVIDIA CORP", tickers: ["NVDA"],
      filings: { recent: {
        accessionNumber: ["0001045810-26-000101", "0001045810-26-000090", "0001045810-25-000010"],
        filingDate: ["2026-10-29", "2026-08-27", "2025-02-26"],
        reportDate: ["2026-10-29", "2026-07-27", "2025-01-26"],
        form: ["8-K", "10-Q", "10-K"],
        primaryDocument: ["nvda-8k.htm", "nvda-10q.htm", "nvda-10k.htm"],
        primaryDocDescription: ["8-K", "10-Q", "10-K"],
        items: ["5.02", "", ""],
      } },
    });
    if (url.includes("/companyfacts/CIK0001045810.json")) return json({ facts: { "us-gaap": {
      Revenues: { units: { USD: [
        { start: "2026-04-28", end: "2026-07-27", val: 46000, form: "10-Q", filed: "2026-08-27", fp: "Q2" },
        { start: "2026-04-28", end: "2026-07-27", val: 46500, form: "10-Q/A", filed: "2026-09-10", fp: "Q2" },
        { start: "2025-01-27", end: "2026-01-25", val: 150000, form: "10-K", filed: "2026-02-25", fp: "FY" },
        { start: "2026-04-28", end: "2026-07-27", val: 1, form: "8-K", filed: "2026-08-28" },
      ] } },
      Assets: { units: { USD: [{ end: "2026-07-27", val: 120000, form: "10-Q", filed: "2026-08-27" }] } },
      EarningsPerShareDiluted: { units: { "USD/shares": [{ start: "2026-04-28", end: "2026-07-27", val: 1.05, form: "10-Q", filed: "2026-08-27" }] } },
    } } });
    throw new Error(url);
  };
  const ctx = { fetch: f, now: () => NOW, secUserAgent: "GQuants research team ops@gquants.com" };
  const r = await filings.tool.run({ market: "us", company: "nvda", days: 120, financials: true }, ctx);
  assert.equal(r.company, "NVIDIA CORP");
  assert.equal(r.cik, "0001045810");
  assert.deepEqual(r.items.map((x) => x.form), ["8-K", "10-Q"], "older than the window is left out");
  assert.equal(r.items[0].url, "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000101/nvda-8k.htm");
  assert.equal(r.items[0].details, "8-K items: 5.02");
  assert.match(r.note, /5\.02 officer/);
  const rev = r.financials.revenue;
  assert.equal(rev.values[0].value, 46500, "the amendment filed later wins");
  assert.equal(rev.values[0].period, "quarter");
  assert.equal(rev.values[1].period, "full year");
  assert.equal(rev.values.length, 2, "8-K figures are ignored");
  assert.equal(r.financials.total_assets.values[0].period, "as of");
  assert.equal(r.financials.eps_diluted.unit, "USD/shares");
  assert.deepEqual([...uas], ["GQuants research team ops@gquants.com"], "SEC gets the configured identity on every call");

  const q = await filings.tool.run({ market: "us", company: "NVIDIA", days: 120, forms: "10-Q" }, ctx);
  assert.deepEqual(q.items.map((x) => x.form), ["10-Q"]);
  assert.equal(q.financials, undefined);
  const no = await filings.tool.run({ market: "us", company: "Toyota Motor", days: 30 }, ctx);
  assert.match(no.error, /no registrant matching/);
});

test("filings us: SEC 403 explains SEC_USER_AGENT; the default identity is used when it is not set", async () => {
  filings._reset();
  let ua;
  const r = await filings.tool.run({ market: "us", company: "AAPL" }, { fetch: async (u, o) => { ua = o.headers["user-agent"]; return text("blocked", 403); }, now: () => NOW });
  assert.match(r.hint, /SEC_USER_AGENT/);
  assert.equal(ua, filings.DEFAULT_SEC_UA);
  assert.equal(cfgMod.load({ SEC_USER_AGENT: "X x@y.com" }).secUserAgent, "X x@y.com");
});

test("telegram: /tasks all lists every chat's tasks for admins only", async () => {
  const w = botWorld();
  w.bot.runner.create({ chatId: "-100500", createdBy: "111", instruction: "India macro news every morning", scheduleText: "daily 08:30" });
  w.bot.runner.create({ chatId: "222", createdBy: "222", instruction: "US tech filings and results", scheduleText: "weekdays 19:00" });
  await w.bot.handle({ update_id: 1, message: msg("/tasks all") });
  assert.match(w.sent.at(-1).text, /All tasks \(2, 2 active\)[\s\S]*Chat -100500:[\s\S]*Chat 222:/);
  await w.bot.handle({ update_id: 2, message: msg("/tasks all", { id: 222, first_name: "Sam" }) });
  assert.match(w.sent.at(-1).text, /Only admins/);
});
