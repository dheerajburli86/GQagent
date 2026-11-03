#!/usr/bin/env node
"use strict";
// Runs evals/questions.json through the real agent (your keys, your data,
// no Telegram) and writes every answer next to what was expected, for a human
// to grade:   node scripts/evals.js [--only 1,5,9]
// Costs model tokens: about 33 answers' worth.
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
const { answer } = require("../src/answer");
const { PROJECTS } = require("../src/projects");
const { SnapshotStore } = require("../src/snapshots");
const { buildLiveClients } = require("../src/tools/live");

(async () => {
  const provider = createProvider(cfg);
  if (!provider) { console.error("DEEPINFRA_API_KEY is not set."); process.exit(1); }
  const onlyArg = process.argv.indexOf("--only");
  const only = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(",").map(Number)) : null;
  const qs = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "evals", "questions.json"), "utf8")).filter((q) => !only || only.has(q.id));
  const snapshots = new SnapshotStore({ projects: PROJECTS, token: cfg.githubToken, workDir: os.tmpdir(), maxFileKb: cfg.snapshotMaxFileKb, maxTotalMb: cfg.snapshotMaxTotalMb });
  let live = {}, liveOn = false;
  if (cfg.heatmapSupabaseUrl && cfg.heatmapSupabaseKey) {
    const { createClient } = require("@supabase/supabase-js");
    live = buildLiveClients(createClient(cfg.heatmapSupabaseUrl, cfg.heatmapSupabaseKey, { auth: { persistSession: false, autoRefreshToken: false } }));
    liveOn = true;
  }
  const researchTool = cfg.xaiKey ? require("../src/tools/research").makeTool({ apiKey: cfg.xaiKey, model: cfg.grokResearchModel }) : null;
  const out = [];
  for (const q of qs) {
    const started = Date.now();
    let row;
    try {
      const r = await answer({ provider, cfg, snapshots, live, liveOn, researchTool, question: q.q, projects: q.projects, user: { label: "evals" } });
      row = { ...q, answer: r.answer, tools: r.steps.map((s) => s.tool), projects_used: r.projectsUsed, model: r.model, ms: r.ms };
    } catch (e) { row = { ...q, error: String(e.message || e).slice(0, 300), ms: Date.now() - started }; }
    out.push(row);
    console.log(`#${q.id} ${row.ms}ms tools=${(row.tools || []).join(",") || "-"}\n  Q: ${q.q}\n  expect: ${q.expect}\n  A: ${String(row.answer || row.error).replace(/\s+/g, " ").slice(0, 300)}\n`);
  }
  const file = path.join(process.cwd(), `eval-results-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Wrote ${file}`);
})();
