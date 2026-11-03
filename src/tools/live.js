"use strict";
// Live, read-only database tools, per project. The tool bodies are
// dashboard tools (originally team-agent's), unchanged; what changes is the handle
// they run against: a readOnlyClient limited to the tables and RPCs below.
// Neither table names nor RPC names ever come from the model.
const dashboard = require("./dashboard");
const { readOnlyClient } = require("../readonly");
const { guardProject, markUsed } = require("./scope");

const SOURCES = {
  heatmap: {
    project: "heatmap-dashboard",
    tables: [
      "instruments", "returns_latest", "price_history", "india_volume_daily", "fundamentals",
      "tech_indicators_rsi", "tech_indicators_macd", "tech_trend_identification", "tech_indicators_52w", "tech_indicators_ath",
    ],
    rpcs: ["team_agent_screen", "team_agent_overview"], // both are `language sql stable` (20261101_team_agent_rpcs.sql)
    tools: dashboard.tools,
  },
};

/** One read-only client per live source, built once at boot. */
function buildLiveClients(sb) {
  const out = {};
  if (!sb) return out;
  for (const [key, s] of Object.entries(SOURCES)) out[key] = readOnlyClient(sb, { tables: s.tables, rpcs: s.rpcs, label: key });
  return out;
}

/** Live tools for the selected projects only; each re-checks the selection when called. */
function makeTools(selected, { projectsById }) {
  const out = [];
  for (const [key, s] of Object.entries(SOURCES)) {
    if (!selected.includes(s.project) || projectsById.get(s.project).live !== key) continue;
    for (const t of s.tools) {
      out.push({
        name: t.name,
        kind: "live",
        project: s.project,
        description: `[${s.project} live database, read-only] ${t.description}`,
        parameters: t.parameters,
        async run(a, ctx) {
          const g = guardProject(ctx, s.project);
          if (g.error) return g;
          const db = ctx.live && ctx.live[key];
          if (!db) return { error: `${s.project} live database is not configured on this server` };
          markUsed(ctx, s.project);
          return t.run(a, { ...ctx, sb: db });
        },
      });
    }
  }
  return out;
}

module.exports = { SOURCES, buildLiveClients, makeTools };
