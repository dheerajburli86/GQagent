"use strict";
// The agent core without any front end: question in, answer out. The Telegram
// bot, the `ask` command and the evals all use this, so they behave the same.
const { runAgent } = require("./agent");
const { buildTools } = require("./tools/index");
const { buildSystemPrompt, withProjectsFooter } = require("./prompt");
const { IDS } = require("./projects");

/**
 * answer({provider, cfg, store, snapshots, live, question, projects, attached, user, liveOn})
 * projects: array of ids, or "all". Returns {answer, steps, usage, projectsUsed, model}.
 */
async function answer({ provider, cfg, snapshots, live = {}, liveOn = false, question, projects = "all", attached = [], user = { label: "test" }, fetchImpl = fetch, researchTool = null }) {
  // snapshots: the SnapshotStore that holds the repo copies (repo tools read ctx.store)
  const selected = projects === "all" ? [...IDS] : projects;
  const ctx = { store: snapshots, live, selected, githubToken: cfg.githubToken, attachments: attached, fetch: fetchImpl, projectsUsed: new Set(), usage: { in: 0, out: 0 }, user, audit: () => {} };
  const tools = buildTools({ selected, user: {}, attached, liveOn, researchTool });
  const started = Date.now();
  const out = await runAgent({
    provider, tools, ctx, history: [], message: question,
    system: buildSystemPrompt({ user, selected, attached, toolNames: tools.map((t) => t.name), telegram: false }),
    maxSteps: cfg.maxSteps, deadline: started + cfg.requestDeadlineMs,
  });
  return {
    answer: withProjectsFooter(out.answer, ctx.projectsUsed, selected),
    steps: out.steps, usage: out.usage, ms: Date.now() - started,
    projectsUsed: selected.filter((id) => ctx.projectsUsed.has(id)),
    model: provider.lastModel || provider.model,
  };
}

module.exports = { answer };
