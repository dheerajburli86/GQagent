"use strict";
// Work assigned to the agent from the ETI dashboard (Agent page). Every ~45 s the agent asks ETI for the oldest
// waiting task, does it with full ETI access, and writes the result back. One task at a time.
const { runWithEngines } = require("./engines");
const { buildTools } = require("./tools/index");
const { buildSystemPrompt } = require("./prompt");

function brief(task, company) {
  return [
    `ASSIGNED TASK #${task.id} from the ETI dashboard${task.assigned_by ? ` (assigned by ${task.assigned_by})` : ""}: "${task.title}"`,
    company ? `Company in focus: ${company.name} (id ${company.id}${company.nse_symbol ? `, ${company.nse_symbol}` : ""}).` : "",
    "",
    `INSTRUCTION: ${task.instruction}`,
    "",
    "Do the work now with the ETI tools (eti_sql / eti_api); nobody is available to answer questions. First look at the real state with eti_sql, then act with eti_api where the task needs changes, then check the result with eti_sql. Do only what the task asks. Never claim something was done unless a tool result confirmed it.",
    "Finish with a short report: what you found, exactly what you changed or queued (with ids / counts), what is still open and why.",
  ].filter(Boolean).join("\n");
}

class EtiTaskWorker {
  /** deps: cfg, eti, engines, snapshots, live, liveOn, researchTool, store, log, notify(text) optional */
  constructor(deps) {
    this.deps = deps;
    this.log = deps.log || console.log;
    this.busy = false;
  }

  start(signal) {
    const t = setInterval(() => { if (!(signal && signal.aborted)) this.tick().catch((e) => this.log(`[eti-tasks] ${e.message}`)); }, (this.deps.cfg.etiPollSeconds || 45) * 1000);
    t.unref && t.unref();
    setTimeout(() => this.tick().catch((e) => this.log(`[eti-tasks] ${e.message}`)), 8000).unref?.();
    return t;
  }

  async tick() {
    const { eti } = this.deps;
    if (this.busy || !eti || !eti.ready) return null;
    this.busy = true;
    try {
      const got = await eti.request("POST", "/agent/tasks/claim", { body: {} });
      if (!got || got.error || !got.task) return null;
      return await this.run(got.task, got.company);
    } finally { this.busy = false; }
  }

  async run(task, company) {
    const { cfg, eti, engines, snapshots, live, liveOn, researchTool, store, notify } = this.deps;
    this.log(`[eti-tasks] #${task.id} started: ${task.title}`);
    const selected = ["eti"];
    const ctx = {
      store: snapshots, live: live || {}, selected, githubToken: cfg.githubToken, attachments: [], fetch, projectsUsed: new Set(),
      usage: { in: 0, out: 0 }, user: { id: `eti-task:${task.id}`, label: `assigned ETI task #${task.id}` },
      eti, etiTask: true, etiWrite: true, audit: ({ tool, args, ok }) => this.log(`[eti-tasks] #${task.id} ${tool} ${args && args.method ? `${args.method} ${args.path}` : ""} ${ok ? "ok" : "failed"}`),
    };
    const started = Date.now();
    try {
      const out = await runWithEngines({
        mode: "default", engines, researchTool: researchTool || null,
        buildTools: (research) => buildTools({ selected, user: {}, attached: [], liveOn: false, researchTool: research, eti }),
        buildSystem: (toolNames) => buildSystemPrompt({ user: { label: `the ETI task runner (task #${task.id})` }, selected, toolNames, telegram: false, scheduled: true }),
        ctx, history: [], message: brief(task, company),
        maxSteps: cfg.etiTaskMaxSteps || 30, deadline: started + (cfg.etiTaskDeadlineMs || 600000),
        checkBudget: store ? () => store.check(`eti-task:${task.id}`, cfg, new Date(), { daily: false }) : undefined,
      });
      if (store) store.record(`eti-task:${task.id}`, ctx.usage.in || 0, ctx.usage.out || 0, new Date());
      await eti.request("POST", `/agent/tasks/${task.id}/report`, { body: { status: "done", result: out.answer, steps: out.steps.length } });
      this.log(`[eti-tasks] #${task.id} done (${out.steps.length} tool calls, ${Math.round((Date.now() - started) / 1000)}s)`);
      if (notify) await notify(`✅ ETI task #${task.id} done: ${task.title}\n\n${String(out.answer).slice(0, 1500)}`).catch(() => {});
      return { status: "done" };
    } catch (e) {
      const reason = String(e.message || e).slice(0, 300);
      await eti.request("POST", `/agent/tasks/${task.id}/report`, { body: { status: "failed", error: reason } }).catch(() => {});
      this.log(`[eti-tasks] #${task.id} failed: ${reason}`);
      if (notify) await notify(`⚠️ ETI task #${task.id} failed: ${task.title}\n${reason}`).catch(() => {});
      return { status: "failed", error: reason };
    }
  }
}

module.exports = { EtiTaskWorker, brief };
