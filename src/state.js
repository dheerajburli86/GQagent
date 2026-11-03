"use strict";
// The only things stored: each chat's project selection, token spend for the
// daily per-person and monthly team budgets, scheduled tasks, and the team's
// watchlists (holdings, interest lists). Kept in one small JSON file
// in DATA_DIR (a Railway volume). Nothing about questions or answers is stored.
// Conversation memory is in RAM only and resets on restart.
const fs = require("fs");
const path = require("path");
const { BudgetError } = require("./errors");

const istDay = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
const istMonth = (d = new Date()) => istDay(d).slice(0, 7);
const KEEP_DAYS = 40;

class Store {
  constructor(dir, log = console.log) {
    this.file = path.join(dir, "state.json");
    this.log = log;
    this.data = { chats: {}, usage: {}, tasks: {}, taskSeq: 0, lists: {} };
    this.persistent = true;
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(this.file)) this.data = { chats: {}, usage: {}, tasks: {}, taskSeq: 0, lists: {}, ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (e) {
      this.persistent = false;
      log(`[state] ${dir} is not usable (${String(e.code || e.message).slice(0, 60)}); settings and budgets will reset on restart. Add a Railway volume at /data.`);
    }
  }

  save() {
    if (!this.persistent) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) { this.log(`[state] could not save: ${String(e.code || e.message).slice(0, 80)}`); }
  }

  // ---- project selection per chat
  projectsFor(chatId) {
    const v = this.data.chats[String(chatId)];
    return v && (v === "all" || Array.isArray(v)) ? v : "all";
  }
  setProjects(chatId, value) {
    this.data.chats[String(chatId)] = value;
    this.save();
  }

  // ---- budgets
  prune(now = new Date()) {
    const cutoff = istDay(new Date(now.getTime() - KEEP_DAYS * 864e5));
    for (const k of Object.keys(this.data.usage)) if (k.startsWith("day:") && k.slice(4, 14) < cutoff) delete this.data.usage[k];
  }
  spendToday(userId, now = new Date()) { return this.data.usage[`day:${istDay(now)}:${userId}`] || 0; }
  spendThisMonth(now = new Date()) { return this.data.usage[`month:${istMonth(now)}`] || 0; }

  /** Throws BudgetError when a cap is used up. A cap of 0 means no cap. */
  check(userId, cfg, now = new Date(), { daily = true } = {}) {
    if (daily && cfg.dailyTokensPerUser > 0 && this.spendToday(userId, now) >= cfg.dailyTokensPerUser)
      throw new BudgetError("You have used today's allowance. It resets at midnight IST.");
    if (cfg.monthlyTokensGlobal > 0 && this.spendThisMonth(now) >= cfg.monthlyTokensGlobal)
      throw new BudgetError("The team's monthly budget for the agent is used up. Ask an admin to raise AGENT_MONTHLY_TOKENS.");
  }

  record(userId, tokensIn, tokensOut, now = new Date()) {
    const n = Math.round(tokensIn + tokensOut);
    if (!n) return;
    const dk = `day:${istDay(now)}:${userId}`, mk = `month:${istMonth(now)}`;
    this.data.usage[dk] = (this.data.usage[dk] || 0) + n;
    this.data.usage[mk] = (this.data.usage[mk] || 0) + n;
    this.prune(now);
    this.save();
  }
}

// ---- scheduled tasks (persisted with everything else) --------------------------------
const TASK_SEEN_MAX = 300;
Object.assign(Store.prototype, {
  addTask(t) {
    this.data.tasks = this.data.tasks || {};
    this.data.taskSeq = (this.data.taskSeq || 0) + 1;
    const id = this.data.taskSeq;
    const task = { id, enabled: true, runs: 0, failures: 0, tokens: 0, seen: [], lastRunAt: null, lastStatus: null, createdAt: new Date().toISOString(), ...t };
    task.id = id;
    this.data.tasks[id] = task;
    this.save();
    return task;
  },
  getTask(id) { return (this.data.tasks || {})[Number(id)] || null; },
  listTasks(chatId) {
    const all = Object.values(this.data.tasks || {});
    return (chatId === undefined ? all : all.filter((t) => String(t.chatId) === String(chatId))).sort((a, b) => a.id - b.id);
  },
  updateTask(id, patch) {
    const t = this.getTask(id);
    if (!t) return null;
    Object.assign(t, patch);
    if (t.seen && t.seen.length > TASK_SEEN_MAX) t.seen = t.seen.slice(-TASK_SEEN_MAX);
    this.save();
    return t;
  },
  deleteTask(id) {
    const t = this.getTask(id);
    if (!t) return false;
    delete this.data.tasks[Number(id)];
    this.save();
    return true;
  },
});

// ---- watchlists: named team lists (e.g. "india-holdings", "global-holdings", "interest") --
// Shared by every chat: holdings belong to the team, not to a conversation.
const LIST_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const LIST_MAX = 50, LIST_ITEMS_MAX = 500, ITEM_MAX = 120;
const normName = (n) => String(n || "").trim().toLowerCase().replace(/\s+/g, "-");
const splitItems = (v) => (Array.isArray(v) ? v : String(v || "").split(/[,;\n]+/))
  .map((x) => String(x).replace(/\s+/g, " ").trim().slice(0, ITEM_MAX)).filter(Boolean);
const sameItem = (a, b) => a.toLowerCase() === b.toLowerCase();

Object.assign(Store.prototype, {
  lists() { this.data.lists = this.data.lists || {}; return Object.values(this.data.lists).sort((a, b) => a.name.localeCompare(b.name)); },
  getList(name) { return (this.data.lists || {})[normName(name)] || null; },
  /** op: create | add | remove | set | describe | delete. Returns { list } or { deleted } or { error }. */
  editList(op, name, { items, description, by } = {}) {
    this.data.lists = this.data.lists || {};
    const key = normName(name);
    if (!LIST_NAME.test(key)) return { error: "list names use letters, digits, - and _ (up to 40), e.g. india-holdings" };
    let l = this.data.lists[key];
    if (op === "delete") {
      if (!l) return { error: `there is no list "${key}"` };
      delete this.data.lists[key]; this.save();
      return { deleted: key };
    }
    if (!l) {
      if (op === "remove" || op === "describe") return { error: `there is no list "${key}"` };
      if (Object.keys(this.data.lists).length >= LIST_MAX) return { error: `there are already ${LIST_MAX} lists; delete one first` };
      l = this.data.lists[key] = { name: key, description: "", items: [], createdAt: new Date().toISOString() };
    }
    const it = splitItems(items);
    if (op === "set") l.items = [];
    if (op === "add" || op === "set" || op === "create") for (const x of it) if (!l.items.some((y) => sameItem(x, y))) l.items.push(x);
    let missing = [];
    if (op === "remove") {
      missing = it.filter((x) => !l.items.some((y) => sameItem(x, y)));
      l.items = l.items.filter((y) => !it.some((x) => sameItem(x, y)));
    }
    if (l.items.length > LIST_ITEMS_MAX) l.items = l.items.slice(0, LIST_ITEMS_MAX);
    if (description !== undefined && description !== null && String(description).trim()) l.description = String(description).trim().slice(0, 300);
    l.updatedAt = new Date().toISOString();
    if (by) l.updatedBy = String(by).slice(0, 80);
    this.save();
    return missing.length ? { list: l, not_found: missing } : { list: l };
  },
});

/** In-RAM sliding-window limiter: N messages per minute per person. */
class RateLimiter {
  constructor(perMin) { this.perMin = perMin; this.hits = new Map(); }
  take(key, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < 60_000);
    if (arr.length >= this.perMin) { this.hits.set(key, arr); return false; }
    arr.push(now); this.hits.set(key, arr);
    return true;
  }
}

module.exports = { Store, RateLimiter, istDay, istMonth, normName, splitItems };
