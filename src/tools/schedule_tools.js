"use strict";
// Lets the agent create and manage scheduled monitoring tasks when someone asks
// in plain words ("send me India macro news every morning"). Only offered in
// live conversations (never inside a scheduled run), and only for the chat the
// request came from. Changing or deleting a task needs its creator or an admin.
const schedule = require("../schedule");
const { IDS } = require("../projects");

const summary = (t) => ({
  id: t.id, title: t.title, schedule: t.schedule, mode: t.mode, enabled: t.enabled,
  next_run: t.enabled ? schedule.fmtIst(t.nextRunAt) : "paused", last_run: schedule.fmtIst(t.lastRunAt),
  last_status: t.lastStatus || "not run yet", projects: t.projects.length ? t.projects : "none", instruction: t.instruction,
});

function canChange(ctx, t) {
  return ctx.task.admin || String(t.createdBy) === String(ctx.task.userId);
}

function makeTools() {
  return [
    {
      name: "schedule_task",
      description: `Create a recurring monitoring task in this chat. Use it ONLY when the user asks for something to be done regularly or watched over time. Write 'instruction' as a complete brief someone could follow without this conversation: what to cover (companies, sectors, countries, themes, sources), what counts as relevant, and anything to leave out. Schedules (IST): ${schedule.SCHEDULE_HELP}. Mode 'alerts' reports only material events; 'digest' reports everything new and relevant.`,
      parameters: {
        type: "object",
        properties: {
          instruction: { type: "string", description: "self-contained brief of what to monitor and report" },
          schedule: { type: "string", description: "e.g. 'daily 08:30', 'every 2h', 'weekdays 09:15, 15:45'" },
          title: { type: "string", description: "short name, under 60 characters" },
          mode: { type: "string", enum: ["digest", "alerts"], description: "default digest" },
          projects: { type: "string", description: "projects the task may read. Default 'auto': only the live market data (heatmap-dashboard) if this chat reads it, since monitoring the news rarely needs code. Use 'current' (this chat's selection), 'none', 'all', or comma-separated ids when the task is about a project's code or docs." },
        },
        required: ["instruction", "schedule"],
      },
      async run(a, ctx) {
        if (!ctx.task) return { error: "tasks are not available here" };
        let projects = ctx.task.chatProjects;
        const p = String(a.projects || "auto").trim().toLowerCase();
        if (p === "auto") projects = ctx.task.chatProjects.filter((id) => id === "heatmap-dashboard");
        else if (p === "none") projects = [];
        else if (p === "all") projects = [...IDS];
        else if (p !== "current") {
          projects = p.split(/[\s,]+/).filter(Boolean);
          const bad = projects.filter((x) => !IDS.includes(x));
          if (bad.length) return { error: `unknown project(s): ${bad.join(", ")}. Known: ${IDS.join(", ")}` };
        }
        const r = ctx.task.runner.create({
          chatId: ctx.task.chatId, createdBy: ctx.task.userId, createdByLabel: ctx.task.userLabel,
          instruction: a.instruction, scheduleText: a.schedule, title: a.title, mode: a.mode, projects, engine: ctx.task.engine,
        });
        if (r.error) return { error: r.error };
        return { created: summary(r.task), note: "Confirm in one or two plain sentences: what you will send, and when (e.g. 'Done. Every weekday at 9:15 am I\'ll send you ...'). Say they can tap 🔔 My updates to run, pause or remove it. Do not mention task numbers or commands." };
      },
    },
    {
      name: "list_scheduled_tasks",
      description: "List the scheduled monitoring tasks in this chat, with their schedules, next and last runs, and status.",
      parameters: { type: "object", properties: { include_instructions: { type: "boolean", description: "include each task's full brief" } } },
      async run(a, ctx) {
        if (!ctx.task) return { error: "tasks are not available here" };
        const list = ctx.task.runner.store.listTasks(ctx.task.chatId).map(summary);
        return { tasks: a.include_instructions ? list : list.map(({ instruction, ...rest }) => rest), count: list.length };
      },
    },
    {
      name: "manage_scheduled_task",
      description: "Change a scheduled task in this chat: pause, resume, delete, run it now, change its schedule, or rewrite its instruction. Only its creator or an admin can change it.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer", description: "task number" },
          action: { type: "string", enum: ["pause", "resume", "delete", "run_now", "reschedule", "edit"] },
          schedule: { type: "string", description: "for reschedule" },
          instruction: { type: "string", description: "for edit: the new full brief" },
          mode: { type: "string", enum: ["digest", "alerts"], description: "for edit (optional)" },
        },
        required: ["id", "action"],
      },
      async run(a, ctx) {
        if (!ctx.task) return { error: "tasks are not available here" };
        const { runner } = ctx.task;
        const t = runner.store.getTask(a.id);
        if (!t || String(t.chatId) !== String(ctx.task.chatId)) return { error: `there is no task #${a.id} in this chat` };
        if (!canChange(ctx, t)) return { error: `only the person who created task #${t.id} or an admin can change it` };
        switch (a.action) {
          case "pause": return { done: summary(runner.setEnabled(t.id, false).task) };
          case "resume": return { done: summary(runner.setEnabled(t.id, true).task) };
          case "delete": runner.store.deleteTask(t.id); return { done: `task #${t.id} deleted` };
          case "run_now": runner.run(t.id, { manual: true }); return { done: `task #${t.id} is running now; its update will be posted here when ready` };
          case "reschedule": { const r = runner.reschedule(t.id, a.schedule); return r.error ? { error: r.error } : { done: summary(r.task) }; }
          case "edit": {
            const text = String(a.instruction || "").trim();
            if (text.length < 8) return { error: "give the new instruction" };
            return { done: summary(runner.store.updateTask(t.id, { instruction: text.slice(0, 3000), ...(a.mode ? { mode: a.mode === "alerts" ? "alerts" : "digest" } : {}) })) };
          }
          default: return { error: "unknown action" };
        }
      },
    },
  ];
}

module.exports = { makeTools, summary };
