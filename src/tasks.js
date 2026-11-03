"use strict";
// Scheduled monitoring tasks: defined once, run on their own schedule, post only
// what is new. Each run is an ordinary agent turn with a monitoring brief, the
// list of what it already reported (so nothing repeats), and the task's own
// project selection. Runs happen beside normal chat, a few at a time.
const { runWithEngines } = require("./engines");
const { buildTools } = require("./tools/index");
const { buildSystemPrompt } = require("./prompt");
const schedule = require("./schedule");
const { BudgetError } = require("./errors");

const NOTHING = "NOTHING_NEW";
const SEEN_IN_PROMPT = 80;

const ALERT_RULE = "Only report MATERIAL events: results or guidance, rating or outlook changes, management or board changes, M&A, large orders or contracts, capacity or product launches with numbers, regulatory, legal or tax action, defaults, fraud or governance issues, index inclusion or exclusion, policy-rate or major macro-data surprises, major government policy. Skip routine commentary, previews, price-move stories without a cause, and opinion pieces.";
const DIGEST_RULE = "Report every new item that is relevant to the task, most important first. Skip duplicates of the same story from different outlets (keep the most authoritative source), price-move stories without a cause, and SEO filler.";

/** The question given to the agent for one run of a task. */
function buildRunPrompt(task, now = new Date()) {
  const spec = schedule.parse(task.schedule, { minMinutes: 1 }).spec;
  const since = task.lastRunAt
    ? `The last run was at ${schedule.fmtIst(task.lastRunAt)}. Report only what happened or was published after that (allow a little overlap for late-indexed news).`
    : `This is the first run: cover roughly the last ${spec ? schedule.lookback(spec) : "24 hours"}.`;
  const seen = (task.seen || []).slice(-SEEN_IN_PROMPT);
  return [
    `SCHEDULED TASK #${task.id}: "${task.title}". Runs ${spec ? schedule.describe(spec) : task.schedule}. Mode: ${task.mode === "alerts" ? "alerts (material events only)" : "digest"}. Now: ${schedule.fmtIst(now)}.`,
    since,
    "",
    `TASK: ${task.instruction}`,
    "",
    seen.length ? `Already reported in earlier runs (do NOT report these again, even if another outlet reworded them):\n${seen.map((x) => `- ${x}`).join("\n")}` : "Nothing has been reported for this task yet.",
    "",
    "How to do this run:",
    "1. Work out every company, sector, country, theme or source the task covers. If it refers to the team's own lists ('our holdings', 'our portfolio', 'our watchlist', 'companies we track', or a list by name), call watchlists FIRST and use the list as it stands today. Expand public groups (e.g. 'Nifty IT', 'G7 central banks') yourself. If a list the task needs does not exist or is empty, say so once at the top of the update instead of guessing.",
    `2. Search for recent developments for each: web_search with kind "news" and recent_hours / recent_days matching the window, and web_research (when available) for anything needing several sources or deeper reading. For countries and macro themes ('macro news', 'the economy in <country>', 'central banks', 'all our countries', 'the countries on the Global Indices tile') use macro_news: it covers every country on the dashboard's Global Indices tile from official sources first, and takes a topic and a window. For Indian and US companies also check company_filings over the same window (results, concall transcripts, presentations, board outcomes, 8-Ks): a company's own disclosure outranks a news story about it. Open primary sources (filings, results, transcripts, regulators, central banks, statistics offices) with web_fetch when the detail matters. Use the live market tools for price and return context when available. With many companies, cover them all: batch independent tool calls in one step.`,
    `3. ${task.mode === "alerts" ? ALERT_RULE : DIGEST_RULE}`,
    "4. Write the update for a busy investment team: group by company, sector or country; for each item a bold one-line headline, then one or two lines on what happened, the key numbers, and why it matters for this task; then the source link and its date. Neutral: no buy, sell or hold calls and no price targets. Keep the whole update under about 2,500 characters unless the task asks for more.",
    `5. If there is nothing new and relevant since the last run, reply with exactly: ${NOTHING}`,
    "6. Finish with one line per item you reported, in the form `SEEN: <source URL or a short unique description>`. These lines are hidden from readers and stop the same item from being reported again.",
  ].join("\n");
}

/** Splits the model's reply into the visible update and the SEEN keys. */
function parseRunReply(text) {
  const seen = [];
  const lines = [];
  for (const l of String(text || "").split("\n")) {
    const m = /^\s*[-*]?\s*`?SEEN:\s*(.+?)`?\s*$/i.exec(l);
    if (m) seen.push(m[1].trim().replace(/^`+|`+$/g, "").trim().slice(0, 200));
    else lines.push(l);
  }
  const body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const nothing = !body || new RegExp(`^\\W*${NOTHING}\\W*$`).test(body) || (body.startsWith(NOTHING) && body.length < NOTHING.length + 80);
  return { body: nothing ? "" : body, seen, nothing };
}

/** Runs one task once. deps: provider, cfg, store, snapshots, live, liveOn, researchTool, fetchImpl. */
async function executeTask(task, deps, now = new Date()) {
  const { cfg } = deps;
  const engines = deps.engines || { deepinfra: deps.provider || null, grok: null };
  if (!engines.deepinfra && !engines.grok) throw new Error("the model is not configured (DEEPINFRA_API_KEY or XAI_API_KEY)");
  const selected = Array.isArray(task.projects) ? task.projects : [];
  const ctx = {
    store: deps.snapshots, live: deps.live || {}, selected, githubToken: cfg.githubToken, attachments: [],
    fetch: deps.fetchImpl || fetch, projectsUsed: new Set(), usage: { in: 0, out: 0 },
    lists: deps.store || null, secUserAgent: cfg.secUserAgent || undefined,
    user: { id: `task:${task.id}`, label: `scheduled task #${task.id}` }, audit: () => {},
  };
  const started = Date.now();
  try {
    const out = await runWithEngines({
      mode: task.engine || "default", engines, researchTool: deps.researchTool || null,
      buildTools: (research) => buildTools({ selected, user: {}, attached: [], liveOn: !!deps.liveOn, researchTool: research }),
      buildSystem: (toolNames) => buildSystemPrompt({ user: { label: `scheduled monitoring task #${task.id} (created by ${task.createdByLabel || "a team member"})` }, selected, toolNames, telegram: true, scheduled: true }),
      ctx, history: [], message: buildRunPrompt(task, now),
      maxSteps: cfg.taskMaxSteps, deadline: started + cfg.taskDeadlineMs,
      checkBudget: deps.store ? () => deps.store.check(`task:${task.id}`, cfg, now, { daily: false }) : undefined,
    });
    return { ...parseRunReply(out.answer), usage: ctx.usage, steps: out.steps, ms: Date.now() - started, projectsUsed: [...ctx.projectsUsed] };
  } catch (e) {
    e.usage = ctx.usage;
    throw e;
  }
}

/** Normalises a SEEN key so the same link or line matches next time. */
function seenKey(s) {
  return String(s).trim().replace(/^<|>$/g, "").replace(/[?#].*$/, (q) => (/^https?:/i.test(s) ? "" : q)).replace(/\/$/, "").toLowerCase();
}

class TaskRunner {
  /**
   * deps: cfg, store, provider, snapshots, live, liveOn, researchTool, fetchImpl,
   *       post(chatId, markdown) -> Promise, isChatAllowed(chatId) -> bool, log, now
   */
  constructor(deps) {
    this.deps = deps;
    this.cfg = deps.cfg;
    this.store = deps.store;
    this.log = deps.log || console.log;
    this.now = deps.now || (() => new Date());
    this.running = new Set();
  }

  /** Creates a task after validating it. Returns { task } or { error }. */
  create({ chatId, createdBy, createdByLabel, instruction, scheduleText, title, mode = "digest", projects = [], engine = "default" }) {
    const text = String(instruction || "").trim();
    if (text.length < 8) return { error: "describe what the task should watch for (at least a sentence)" };
    if (text.length > 3000) return { error: "the task description is too long (3,000 characters max)" };
    const p = schedule.parse(scheduleText, { minMinutes: this.cfg.taskMinIntervalMinutes });
    if (p.error) return { error: p.error };
    if (this.store.listTasks(chatId).length >= this.cfg.taskMaxPerChat) return { error: `this chat already has ${this.cfg.taskMaxPerChat} tasks; delete some first` };
    if (this.store.listTasks().length >= this.cfg.taskMaxTotal) return { error: `the bot already runs ${this.cfg.taskMaxTotal} tasks in total; delete some first` };
    const m = mode === "alerts" ? "alerts" : "digest";
    const t = this.store.addTask({
      chatId: String(chatId), createdBy: String(createdBy), createdByLabel: createdByLabel || "",
      title: String(title || text.split(/[.\n]/)[0]).trim().slice(0, 80) || "Monitoring task",
      instruction: text, schedule: schedule.describe(p.spec), mode: m, projects: [...projects],
      engine: ["grok", "deepinfra", "both"].includes(engine) ? engine : "default",
      nextRunAt: schedule.nextRun(p.spec, this.now()).toISOString(),
    });
    return { task: t };
  }

  reschedule(id, scheduleText) {
    const t = this.store.getTask(id);
    if (!t) return { error: "no such task" };
    const p = schedule.parse(scheduleText, { minMinutes: this.cfg.taskMinIntervalMinutes });
    if (p.error) return { error: p.error };
    return { task: this.store.updateTask(id, { schedule: schedule.describe(p.spec), nextRunAt: schedule.nextRun(p.spec, this.now(), t.lastRunAt ? new Date(t.lastRunAt) : null).toISOString() }) };
  }

  setEnabled(id, enabled) {
    const t = this.store.getTask(id);
    if (!t) return { error: "no such task" };
    const patch = { enabled, failures: enabled ? 0 : t.failures };
    if (enabled) {
      const spec = schedule.parse(t.schedule, { minMinutes: 1 }).spec;
      patch.nextRunAt = schedule.nextRun(spec, this.now(), t.lastRunAt ? new Date(t.lastRunAt) : null).toISOString();
    }
    return { task: this.store.updateTask(id, patch) };
  }

  /** Called on a timer: starts every due task, up to the concurrency limit. */
  tick() {
    if (!this.cfg.tasksEnabled) return [];
    const now = this.now().getTime();
    const due = this.store.listTasks().filter((t) => t.enabled && !this.running.has(t.id) && t.nextRunAt && new Date(t.nextRunAt).getTime() <= now)
      .sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt));
    const started = [];
    for (const t of due) {
      if (this.running.size >= this.cfg.taskConcurrency) break;
      started.push(this.run(t.id));
    }
    return started;
  }

  start(signal) {
    const timer = setInterval(() => { if (!(signal && signal.aborted)) this.tick(); }, 30000);
    timer.unref && timer.unref();
    setTimeout(() => this.tick(), 5000).unref?.();
    return timer;
  }

  /** Runs a task now. manual=true posts "nothing new" too, so the person sees it ran. */
  async run(id, { manual = false } = {}) {
    const task = this.store.getTask(id);
    if (!task || this.running.has(task.id)) return { skipped: true };
    const prevRunAt = task.lastRunAt;
    this.running.add(task.id);
    const now = this.now();
    const spec = schedule.parse(task.schedule, { minMinutes: 1 }).spec;
    // advance the clock first, so a slow or crashing run is never started twice
    if (!manual) this.store.updateTask(task.id, { nextRunAt: schedule.nextRun(spec, new Date(now.getTime() + 1000), now).toISOString() });
    try {
      if (!this.deps.isChatAllowed(task.chatId)) {
        this.store.updateTask(task.id, { enabled: false, lastStatus: "paused: this chat is no longer allowed" });
        this.log(`[task] #${task.id} paused: chat ${task.chatId} is not allowed any more`);
        return { status: "chat-not-allowed" };
      }
      const r = await executeTask(task, this.deps, now);
      const tokens = Math.round((r.usage.in || 0) + (r.usage.out || 0));
      this.store.record(`task:${task.id}`, r.usage.in || 0, r.usage.out || 0, now);
      const known = new Set((task.seen || []).map(seenKey));
      const fresh = r.seen.filter((x) => !known.has(seenKey(x)));
      const patch = { lastRunAt: now.toISOString(), runs: (task.runs || 0) + 1, failures: 0, tokens: (task.tokens || 0) + tokens, seen: [...(task.seen || []), ...fresh] };
      if (r.nothing) {
        this.store.updateTask(task.id, { ...patch, lastStatus: "nothing new" });
        if (manual) await this.deps.post(task.chatId, `**🔔 ${task.title}**\nNothing new since ${prevRunAt ? schedule.fmtIst(prevRunAt) : "it was set up"}.`, { taskId: task.id });
        this.log(`[task] #${task.id} nothing new (${r.steps.length} tool calls, ${tokens} tokens)`);
        return { status: "nothing" };
      }
      try {
        await this.deps.post(task.chatId, `**🔔 ${task.title}**\n\n${r.body}`, { taskId: task.id });
      } catch (e) {
        if (e.code === 403 || e.code === 400) {
          this.store.updateTask(task.id, { ...patch, enabled: false, lastStatus: `paused: cannot post to the chat (${e.code})` });
          this.log(`[task] #${task.id} paused: cannot post (${e.code})`);
          return { status: "cannot-post" };
        }
        throw e;
      }
      this.store.updateTask(task.id, { ...patch, lastStatus: `posted (${fresh.length || "some"} item${fresh.length === 1 ? "" : "s"})`, lastPostedAt: now.toISOString() });
      this.log(`[task] #${task.id} posted (${r.steps.length} tool calls, ${tokens} tokens, ${Math.round(r.ms / 1000)}s)`);
      return { status: "posted" };
    } catch (e) {
      const usage = e.usage || { in: 0, out: 0 };
      if (usage.in || usage.out) this.store.record(`task:${task.id}`, usage.in, usage.out, now);
      const failures = (task.failures || 0) + 1;
      const reason = e instanceof BudgetError ? e.message : String(e.message || e).slice(0, 160);
      const pause = !(e instanceof BudgetError) && failures >= this.cfg.taskMaxFailures;
      this.store.updateTask(task.id, { failures, lastRunAt: now.toISOString(), lastStatus: `error: ${reason}`, enabled: pause ? false : task.enabled, tokens: (task.tokens || 0) + Math.round(usage.in + usage.out) });
      this.log(`[task] #${task.id} failed (${failures}): ${reason}`);
      if (pause || manual) {
        await this.deps.post(task.chatId, pause
          ? `⚠️ "${task.title}" stopped after ${failures} failed tries, so I've paused it. Tap 🔔 My updates to turn it back on.`
          : `⚠️ "${task.title}" could not run just now. Please try again in a few minutes.`).catch(() => {});
      }
      return { status: "error", error: reason };
    } finally {
      this.running.delete(task.id);
    }
  }
}

module.exports = { TaskRunner, executeTask, buildRunPrompt, parseRunReply, seenKey, NOTHING };
