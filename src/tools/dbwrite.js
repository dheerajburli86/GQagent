"use strict";
// Changing project data, with a human in the loop.
//
//   project_change      insert / update / delete rows in heatmap-dashboard or gq-finxray-us.
//                       NOTHING is written when the tool is called: it checks the request,
//                       counts the rows it would touch, and queues a "Confirm / Cancel"
//                       message for the person. The write happens only when that same
//                       person taps Confirm (Bot.onChangeButton -> execute below).
//   dashboard_watchlist the asker's OWN watchlists on the heatmap dashboard website,
//                       matched by e-mail. Small and reversible, so it runs at once.
//
// Rules that hold for both: team members only (Telegram linked in BusyBee); never in
// scheduled runs; never credential tables or columns; every change is recorded in the
// audit log and the server log. BusyBee is not written here at all: it has its own rules
// and alerts, so it is changed only through BusyBee's own API (tools/busybee.js).
const crypto = require("crypto");
const { cleanRows, isTableAllowed, SENSITIVE } = require("../projectdb");
const { guardProject, markUsed } = require("./scope");
const { clamp, cleanText } = require("./util");

const WOPS = ["eq", "neq", "gt", "gte", "lt", "lte", "is", "in", "ilike"];
const ACTIONS = ["insert", "update", "delete"];
const MAX_ROWS = 100, SOLO_LIMIT = 10, MAX_INSERT = 50, TTL_MS = 10 * 60e3;
const ELEVATED = ["admin", "supervisor"];
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const COLNAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const WRITABLE = ["heatmap-dashboard", "gq-finxray-us"];

class PendingChanges {
  constructor() { this.map = new Map(); }
  add(p) {
    const now = Date.now();
    for (const [k, v] of this.map) if (now - v.at > TTL_MS) this.map.delete(k);
    const id = crypto.randomBytes(5).toString("hex");
    this.map.set(id, { ...p, at: now });
    return id;
  }
  peek(id) { const p = this.map.get(id); return p && Date.now() - p.at <= TTL_MS ? p : null; }
  take(id) { const p = this.peek(id); this.map.delete(id); return p; }
}

function gate(ctx, project) {
  const g = guardProject(ctx, project);
  if (g.error) return g;
  if (g.id === "busybee") return { error: "I don't change BusyBee's data directly, because BusyBee has its own rules and alerts for that. I can create and update BusyBee tasks (that goes through BusyBee properly). Other BusyBee changes, such as comments, projects or OKRs, aren't connected yet.", cannot: true };
  if (!WRITABLE.includes(g.id)) return { error: `${g.id} has no database connected for changes.`, cannot: true };
  const db = ctx.projectDbs && ctx.projectDbs[g.id];
  if (!db) return { error: `${g.id}'s database isn't connected to the assistant (its Supabase URL and key are not set on the server).`, cannot: true };
  if (!ctx.member) return { error: "Changing project data is for GQuants team members only. Link your Telegram in BusyBee (Settings → Telegram) and ask again.", not_a_member: true };
  return { id: g.id, db };
}

function applyWhere(q, where) {
  for (const w of where) {
    let v = w.value;
    if (w.op === "in") v = Array.isArray(v) ? v.slice(0, 500) : [v];
    if (w.op === "is" && ![null, true, false].includes(v)) v = v === "null" ? null : v === "true" ? true : v === "false" ? false : null;
    q = q[w.op](w.column, v);
  }
  return q;
}

function whereText(where) {
  return where.map((w) => `${w.column} ${w.op} ${JSON.stringify(w.value)}`).join(" and ");
}

const trim = (s, n = 180) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

function summarise(p) {
  const rows = p.count;
  if (p.action === "insert") return `Add ${rows} row${rows === 1 ? "" : "s"} to ${p.project} › ${p.table}:\n${p.valuesList.slice(0, 5).map((v) => `  • ${trim(JSON.stringify(v))}`).join("\n")}${rows > 5 ? `\n  … and ${rows - 5} more` : ""}`;
  const sample = (p.sample || []).slice(0, 5).map((r) => `  • ${trim(JSON.stringify(r))}`).join("\n");
  if (p.action === "update") return `Change ${rows} row${rows === 1 ? "" : "s"} in ${p.project} › ${p.table} where ${whereText(p.where)}\nSet: ${trim(JSON.stringify(p.values), 300)}\nRows affected (first ${Math.min(5, rows)}):\n${sample}`;
  return `DELETE ${rows} row${rows === 1 ? "" : "s"} from ${p.project} › ${p.table} where ${whereText(p.where)}. This can't be undone.\nRows affected (first ${Math.min(5, rows)}):\n${sample}`;
}

const projectChange = {
  name: "project_change",
  description: "Propose a change to a project's database: insert, update or delete rows in heatmap-dashboard or gq-finxray-us. It does NOT change anything by itself: it checks the request, counts the rows it would touch and asks the person to tap Confirm. After calling it, tell the person plainly what will change and that nothing has changed until they confirm. Updates and deletes must have a 'where'. Look up exact table and column names with project_tables and the exact rows with project_query first. At most 100 rows; more than 10 rows or any delete needs a BusyBee admin or supervisor. Use 'reason' to say why in a few words. Not for BusyBee (use busybee_create_task / busybee_update_task) and never for credentials.",
  parameters: {
    type: "object",
    properties: {
      project: { type: "string", enum: WRITABLE },
      table: { type: "string" },
      action: { type: "string", enum: ACTIONS },
      values: { description: "update: an object of column → new value. insert: an object, or an array of up to 50 objects." },
      where: {
        type: "array",
        description: "required for update and delete; all conditions must match",
        items: { type: "object", properties: { column: { type: "string" }, op: { type: "string", enum: WOPS }, value: {} }, required: ["column", "op"] },
      },
      reason: { type: "string" },
    },
    required: ["project", "table", "action"],
  },
  async run(a, ctx) {
    const g = gate(ctx, a.project); if (g.error) return g;
    if (!ctx.pending) return { error: "changes are not available in this kind of run", cannot: true };
    const table = String(a.table || "");
    if (!IDENT.test(table)) return { error: "table must be a plain table name" };
    if (!isTableAllowed(table)) return { error: `${table} holds credentials, so I never change it`, cannot: true };
    if (!ACTIONS.includes(a.action)) return { error: `action must be one of ${ACTIONS.join(", ")}` };
    const schema = await g.db.tables();
    const def = schema[table];
    if (!def) return { error: `there is no table "${table}" in ${g.id}`, tables: Object.keys(schema).sort() };
    const cols = Object.keys(def.columns);
    const elevated = ELEVATED.includes(ctx.member.role);

    const where = Array.isArray(a.where) ? a.where.slice(0, 20) : [];
    for (const w of where) {
      if (!COLNAME.test(String(w.column || "")) || !cols.includes(w.column)) return { error: `"${String(w.column).slice(0, 40)}" is not a column of ${table}`, columns: cols };
      if (!WOPS.includes(w.op)) return { error: `op must be one of ${WOPS.join(", ")}` };
    }
    const checkValues = (obj) => {
      if (!obj || typeof obj !== "object" || Array.isArray(obj) || !Object.keys(obj).length) return "values must be an object of column → value";
      for (const k of Object.keys(obj)) {
        if (!cols.includes(k)) return `"${k.slice(0, 40)}" is not a column of ${table} (or is a credential column I never touch)`;
        if (SENSITIVE.SECRET_COL.test(k)) return `${k} is a credential column`;
      }
      return null;
    };

    const p = { project: g.id, table, action: a.action, where, reason: String(a.reason || "").slice(0, 200), by: ctx.member.name || ctx.member.email || ctx.member.telegramId, telegramId: ctx.member.telegramId, role: ctx.member.role };
    if (a.action === "insert") {
      const list = (Array.isArray(a.values) ? a.values : [a.values]).slice(0, MAX_INSERT + 1);
      if (list.length > MAX_INSERT) return { error: `at most ${MAX_INSERT} rows per insert` };
      for (const v of list) { const e = checkValues(v); if (e) return { error: e, columns: cols }; }
      p.valuesList = list; p.count = list.length;
    } else {
      if (!where.length) return { error: `${a.action} needs a 'where' so I know exactly which rows. Look them up with project_query first.` };
      if (a.action === "update") { const e = checkValues(a.values); if (e) return { error: e, columns: cols }; p.values = a.values; }
      const head = await applyWhere(g.db.from(table).select("*", { count: "exact", head: true }), where);
      if (head.error) return { error: `${g.id}.${table}: ${head.error.message}` };
      p.count = head.count || 0;
      if (!p.count) return { error: "no rows match that condition, so nothing would change" };
      if (p.count > MAX_ROWS) return { error: `that would touch ${p.count} rows; the limit is ${MAX_ROWS} at a time. Narrow the condition.`, cannot: true };
      const smp = await applyWhere(g.db.from(table).select("*"), where).limit(5);
      p.sample = smp.error ? [] : cleanRows(smp.data || [], { canSeePay: false });
    }
    if ((a.action === "delete" || p.count > SOLO_LIMIT) && !elevated) {
      return { error: `${a.action === "delete" ? "Deleting rows" : `Changing more than ${SOLO_LIMIT} rows`} needs a BusyBee admin or supervisor, and your BusyBee role is ${ctx.member.role}. Ask an admin to request it.`, cannot: true };
    }
    markUsed(ctx, g.id);
    const id = ctx.pending.add(p);
    (ctx.changeQueue = ctx.changeQueue || []).push(id);
    return { status: "awaiting_confirmation", will_change: summarise(p), rows: p.count, note: "NOTHING has been changed yet. The person will now see Confirm / Cancel buttons. Tell them in one or two plain sentences what will change, and that it only happens when they confirm." };
  },
};

/** Runs a confirmed change. Re-counts first: if the data moved since the preview, it refuses. */
async function execute(p, projectDbs) {
  const db = projectDbs && projectDbs[p.project];
  if (!db) return { ok: false, error: `${p.project} is not connected` };
  const c = db.client;
  try {
    if (p.action === "insert") {
      const r = await c.from(p.table).insert(p.valuesList).select();
      if (r.error) return { ok: false, error: r.error.message };
      return { ok: true, rows: (r.data || []).length || p.count };
    }
    const now = await applyWhere(c.from(p.table).select("*", { count: "exact", head: true }), p.where);
    if (now.error) return { ok: false, error: now.error.message };
    if ((now.count || 0) !== p.count) return { ok: false, error: `the data changed since I checked (${p.count} rows then, ${now.count || 0} now). Nothing was changed; ask me again.` };
    const base = p.action === "update" ? c.from(p.table).update(p.values) : c.from(p.table).delete();
    const r = await applyWhere(base, p.where).select();
    if (r.error) return { ok: false, error: r.error.message };
    return { ok: true, rows: (r.data || []).length };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
}

// ---------------------------------------------------------------- dashboard watchlists
const userCache = new Map();
async function dashboardUser(db, email) {
  const key = `${db.url}|${String(email).toLowerCase()}`;
  const hit = userCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.id;
  let found = null;
  for (let page = 1; page <= 10 && !found; page++) {
    const r = await db.client.auth.admin.listUsers({ page, perPage: 200 });
    if (r.error) throw new Error(r.error.message);
    const users = (r.data && r.data.users) || [];
    found = users.find((u) => String(u.email || "").toLowerCase() === String(email).toLowerCase()) || null;
    if (users.length < 200) break;
  }
  if (found) userCache.set(key, { id: found.id, at: Date.now() });
  return found ? found.id : null;
}

async function resolveInstrument(db, text, universe) {
  const q = cleanText(text, 60);
  if (!q) return { error: "say which stock or ETF" };
  const base = () => { let s = db.from("instruments").select("id, symbol, name, universe, country").eq("is_active", true); if (universe) s = s.eq("universe", universe); return s; };
  const exact = await base().eq("symbol", q.toUpperCase()).limit(10);
  if (exact.error) throw new Error(exact.error.message);
  let rows = exact.data || [];
  if (rows.length !== 1) {
    if (!rows.length) { const byName = await base().ilike("name", `%${q}%`).limit(10); if (byName.error) throw new Error(byName.error.message); rows = byName.data || []; }
    if (!rows.length) return { error: `I couldn't find "${q}" among the dashboard's active instruments` };
    if (rows.length > 1) {
      return { error: `"${q}" matches more than one instrument; ask which one`, candidates: rows.map((r) => ({ symbol: r.symbol, name: r.name, universe: r.universe, country: r.country })) };
    }
  }
  return { instrument: rows[0] };
}

const dashboardWatchlist = {
  name: "dashboard_watchlist",
  description: "Read or change the asker's OWN personal watchlists on the heatmap dashboard website (the star icon). The person is matched to their dashboard account by their BusyBee e-mail. Actions: 'list' (their lists and stocks), 'add' a stock/ETF/index to a list, 'remove' one, 'create' a new list. It only ever touches the asker's own lists, and runs at once (no confirmation needed). Give the ticker or name; if it matches several instruments you get the candidates back and must ask which one (then repeat with 'universe'). If they have several lists and don't say which, ask.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "add", "remove", "create"] },
      watchlist: { type: "string", description: "the list's name, e.g. 'watchlist 1'" },
      instrument: { type: "string", description: "ticker or company name" },
      universe: { type: "string", description: "optional: india_stocks, us_stocks, global, india_etfs, us_etfs, india_indices, ..." },
      name: { type: "string", description: "for 'create': the new list's name" },
    },
    required: ["action"],
  },
  async run(a, ctx) {
    const g = guardProject(ctx, "heatmap-dashboard"); if (g.error) return g;
    const db = ctx.projectDbs && ctx.projectDbs["heatmap-dashboard"];
    if (!db) return { error: "the heatmap dashboard's database isn't connected to the assistant", cannot: true };
    if (!ctx.member) return { error: "Watchlist changes are for GQuants team members. Link your Telegram in BusyBee (Settings → Telegram) and ask again.", not_a_member: true };
    if (!ctx.member.email) return { error: "I don't know your e-mail from BusyBee, so I can't find your dashboard account." };
    if (!ctx.pending) return { error: "changes are not available in this kind of run", cannot: true };
    markUsed(ctx, "heatmap-dashboard");
    const audit = (entry) => ctx.recordChange && ctx.recordChange({ project: "heatmap-dashboard", table: "watchlist_items", by: ctx.member.name || ctx.member.email, telegramId: ctx.member.telegramId, ...entry });
    let uid;
    try { uid = await dashboardUser(db, ctx.member.email); } catch (e) { return { error: `couldn't look up your dashboard account: ${String(e.message).slice(0, 120)}` }; }
    if (!uid) return { error: `There's no heatmap dashboard account for ${ctx.member.email}. Sign up on the dashboard with that e-mail first, then ask again.`, cannot: true };

    const ls = await db.from("watchlists").select("id, name").eq("user_id", uid).order("created_at", { ascending: true });
    if (ls.error) return { error: `couldn't read your watchlists: ${ls.error.message}` };
    let lists = ls.data || [];

    if (a.action === "create") {
      const name = String(a.name || a.watchlist || "").trim().slice(0, 60);
      if (!name) return { error: "give the new list a name" };
      if (lists.some((l) => l.name.toLowerCase() === name.toLowerCase())) return { error: `you already have a list called "${name}"` };
      const r = await db.client.from("watchlists").insert({ user_id: uid, name }).select().single();
      if (r.error) return { error: r.error.message };
      audit({ action: "insert", count: 1, summary: `created watchlist "${name}"`, ok: true });
      return { done: `Created the list "${name}" on your dashboard account.` };
    }

    if (a.action === "list") {
      const out = [];
      for (const l of lists) {
        const it = await db.from("watchlist_items").select("instruments(symbol, name, universe)").eq("watchlist_id", l.id).limit(200);
        out.push({ name: l.name, stocks: (it.data || []).map((x) => x.instruments && `${x.instruments.symbol} (${x.instruments.name})`).filter(Boolean) });
      }
      return { account: ctx.member.email, lists: out, note: out.length ? undefined : "no watchlists yet" };
    }

    if (!lists.length && a.action === "add") {
      const r = await db.client.from("watchlists").insert({ user_id: uid, name: "My Watchlist" }).select().single();
      if (r.error) return { error: r.error.message };
      lists = [r.data];
    }
    let list;
    const want = String(a.watchlist || "").trim().toLowerCase();
    if (want) list = lists.find((l) => l.name.toLowerCase() === want) || lists.find((l) => l.name.toLowerCase().includes(want));
    else if (lists.length === 1) list = lists[0];
    if (!list) return { error: want ? `you have no list called "${a.watchlist}"` : "you have more than one list; ask which one", your_lists: lists.map((l) => l.name) };

    let ins;
    try { ins = await resolveInstrument(db, a.instrument, a.universe); } catch (e) { return { error: String(e.message).slice(0, 160) }; }
    if (ins.error) return ins;
    const inst = ins.instrument;
    const label = `${inst.symbol} (${inst.name}, ${inst.universe})`;

    if (a.action === "add") {
      const r = await db.client.from("watchlist_items").insert({ watchlist_id: list.id, instrument_id: inst.id }).select();
      if (r.error) {
        if (r.error.code === "23505" || /duplicate|unique/i.test(r.error.message)) return { done: `${label} is already in "${list.name}".` };
        return { error: r.error.message };
      }
      audit({ action: "insert", count: 1, summary: `added ${inst.symbol} to "${list.name}"`, ok: true });
      return { done: `Added ${label} to "${list.name}" on the dashboard.`, note: "It shows on the dashboard the next time the page loads." };
    }
    if (a.action === "remove") {
      const r = await db.client.from("watchlist_items").delete().eq("watchlist_id", list.id).eq("instrument_id", inst.id).select();
      if (r.error) return { error: r.error.message };
      if (!(r.data || []).length) return { error: `${label} isn't in "${list.name}"` };
      audit({ action: "delete", count: 1, summary: `removed ${inst.symbol} from "${list.name}"`, ok: true });
      return { done: `Removed ${label} from "${list.name}".` };
    }
    return { error: "action must be list, add, remove or create" };
  },
};

function makeTools(selected, projectDbs) {
  const out = [];
  const can = (p) => selected.includes(p) && projectDbs && projectDbs[p];
  const projects = WRITABLE.filter(can);
  if (projects.length) out.push({ ...projectChange, parameters: { ...projectChange.parameters, properties: { ...projectChange.parameters.properties, project: { type: "string", enum: projects } } } });
  if (can("heatmap-dashboard")) out.push(dashboardWatchlist);
  return out;
}

module.exports = { makeTools, PendingChanges, execute, summarise, projectChange, dashboardWatchlist, resolveInstrument, MAX_ROWS, SOLO_LIMIT };
