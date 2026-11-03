#!/usr/bin/env node
"use strict";
// Try a monitoring task once from your terminal, exactly as the scheduler would
// run it the first time, and print the update. Nothing is saved or posted.
//
//   node scripts/run-task.js "India macro news: RBI, inflation, GDP, rupee"
//   node scripts/run-task.js --alerts --schedule "every 2h" "Big news on TCS, Infosys, HCL, Wipro"
//   node scripts/run-task.js --projects heatmap-dashboard "Moves in our watchlist sectors"
//
// Reads .env if present. Costs model tokens (and Grok searches if XAI_API_KEY is set).
const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = path.join(__dirname, "..", ".env");
if (fs.existsSync(dotenv)) for (const line of fs.readFileSync(dotenv, "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const cfg = require("../src/config").load();
const { createProvider } = require("../src/providers/index");
const { executeTask } = require("../src/tasks");
const { PROJECTS, IDS } = require("../src/projects");
const { SnapshotStore } = require("../src/snapshots");
const { buildLiveClients } = require("../src/tools/live");
const schedule = require("../src/schedule");

(async () => {
  const args = process.argv.slice(2);
  let mode = "digest", sched = "daily 08:30", projects = [];
  const words = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--alerts") mode = "alerts";
    else if (args[i] === "--schedule") sched = args[++i];
    else if (args[i] === "--projects") projects = args[++i] === "all" ? [...IDS] : args[i].split(",").map((s) => s.trim()).filter(Boolean);
    else words.push(args[i]);
  }
  const instruction = words.join(" ").trim();
  if (!instruction) { console.error('Usage: node scripts/run-task.js [--alerts] [--schedule "every 2h"] [--projects a,b|all] "what to watch"'); process.exit(1); }
  const p = schedule.parse(sched);
  if (p.error) { console.error(`Schedule: ${p.error}`); process.exit(1); }
  const provider = createProvider(cfg);
  if (!provider) { console.error("Set DEEPINFRA_API_KEY or XAI_API_KEY."); process.exit(1); }
  let live = {};
  if (cfg.heatmapSupabaseUrl && cfg.heatmapSupabaseKey) {
    const { createClient } = require("@supabase/supabase-js");
    live = buildLiveClients(createClient(cfg.heatmapSupabaseUrl, cfg.heatmapSupabaseKey, { auth: { persistSession: false, autoRefreshToken: false } }));
  }
  const researchTool = cfg.xaiKey ? require("../src/tools/research").makeTool({ apiKey: cfg.xaiKey, model: cfg.grokResearchModel }) : null;
  const snapshots = new SnapshotStore({ projects: PROJECTS, token: cfg.githubToken, workDir: os.tmpdir(), maxFileKb: cfg.snapshotMaxFileKb, maxTotalMb: cfg.snapshotMaxTotalMb });
  const task = { id: 0, title: instruction.slice(0, 60), instruction, schedule: schedule.describe(p.spec), mode, projects, seen: [], lastRunAt: null };
  const r = await executeTask(task, { provider, cfg, snapshots, live, liveOn: Object.keys(live).length > 0, researchTool });
  console.log(r.nothing ? "(nothing new: the scheduler would post nothing)" : r.body);
  if (r.seen.length) console.error(`\n[remembered ${r.seen.length} item(s) so they won't repeat]`);
  console.error(`[${provider.lastModel || provider.model} · ${r.steps.length} tool calls (${[...new Set(r.steps.map((s) => s.tool))].join(", ") || "none"}) · ${r.usage.in}+${r.usage.out} tokens · ${(r.ms / 1000).toFixed(1)}s]`);
})().catch((e) => { console.error(String(e.message || e).slice(0, 400)); process.exit(1); });
