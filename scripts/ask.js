#!/usr/bin/env node
"use strict";
// Ask the agent from your terminal, using your real keys and data, without
// Telegram. Use it to test before you deploy.
//
//   node scripts/ask.js "What is the EMI on 50 lakh at 9% for 20 years?"
//   node scripts/ask.js --projects busybee,gq-finxray-us "When do BusyBee reminders go out?"
//   node scripts/ask.js --file report.pdf "What was the net profit?"
//
// Reads .env (next to package.json) if present. Costs model tokens.
const fs = require("fs");
const path = require("path");
loadDotEnv();
const cfg = require("../src/config").load();
const { createProvider } = require("../src/providers/index");
const { answer } = require("../src/answer");
const os = require("os");
const { PROJECTS, IDS } = require("../src/projects");
const { SnapshotStore } = require("../src/snapshots");
const { extract } = require("../src/documents");
const { buildLiveClients } = require("../src/tools/live");

function loadDotEnv() {
  const f = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

(async () => {
  const args = process.argv.slice(2);
  let projects = "all", file = null;
  const q = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--projects") projects = args[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (args[i] === "--file") file = args[++i];
    else q.push(args[i]);
  }
  const question = q.join(" ").trim();
  if (!question) { console.error('Usage: node scripts/ask.js [--projects a,b] [--file path] "question"'); process.exit(1); }
  if (Array.isArray(projects)) {
    const bad = projects.filter((p) => !IDS.includes(p));
    if (bad.length) { console.error(`Unknown project(s): ${bad.join(", ")}. Use: ${IDS.join(", ")}`); process.exit(1); }
  }
  const provider = createProvider(cfg);
  if (!provider) { console.error("DEEPINFRA_API_KEY is not set."); process.exit(1); }
  let attached = [];
  if (file) {
    const buf = fs.readFileSync(file);
    attached = [await extract({ name: path.basename(file), mime: "", buf })];
  }
  let live = {}, liveOn = false;
  if (cfg.heatmapSupabaseUrl && cfg.heatmapSupabaseKey) {
    const { createClient } = require("@supabase/supabase-js");
    live = buildLiveClients(createClient(cfg.heatmapSupabaseUrl, cfg.heatmapSupabaseKey, { auth: { persistSession: false, autoRefreshToken: false } }));
    liveOn = true;
  }
  const snapshots = new SnapshotStore({ projects: PROJECTS, token: cfg.githubToken, workDir: os.tmpdir(), maxFileKb: cfg.snapshotMaxFileKb, maxTotalMb: cfg.snapshotMaxTotalMb });
  const researchTool = cfg.xaiKey ? require("../src/tools/research").makeTool({ apiKey: cfg.xaiKey, model: cfg.grokResearchModel }) : null;
  const r = await answer({ provider, cfg, snapshots, live, liveOn, question, projects, attached, researchTool, user: { label: "you (terminal)" } });
  console.log(r.answer);
  console.error(`\n[${r.model} · ${r.steps.length} tool call(s) · ${r.usage.in}+${r.usage.out} tokens · ${(r.ms / 1000).toFixed(1)}s]`);
})().catch((e) => { console.error(String(e.message || e).slice(0, 400)); process.exit(1); });
