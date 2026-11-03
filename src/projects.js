"use strict";
const fs = require("fs");
const path = require("path");
const { HttpError } = require("./errors");

/**
 * The four projects. `live` names a read-only database source wired in
 * tools/live.js; null means the agent can read the repo but not its data.
 * Summaries are routing hints for the system prompt only. The agent must
 * read the repo (read_docs / grep_code / read_file) before stating facts.
 */
const PROJECTS = [
  {
    id: "heatmap-dashboard", name: "Heatmap Dashboard", repo: "dheerajburli86/heatmap-dashboard", branch: "main", live: "heatmap",
    summary: "GQuants stock heatmap (React/Vite on Vercel) with Python pipelines and Railway services filling Supabase: India/US/Global stocks, ETFs, indices, crypto; prices, returns, GICS sectors, fundamentals, technicals, volume, alerts.",
  },
  {
    id: "busybee", name: "BusyBee", repo: "dheerajburli86/busybee", branch: "main", live: null,
    summary: "Internal work-management app (Next.js 15 + Supabase): task assignment, review, deadlines, projects, OKRs, timesheet, payroll (IROP), documents, chat, to-dos, reports; Python scheduler for reminders and daily summaries.",
  },
  {
    id: "gq-finxray-us", name: "GQ FinXray US", repo: "dheerajburli86/gq-finxray-us", branch: "main", live: null,
    summary: "Python worker that polls US market sources (SEC EDGAR, FMP, Massive, RSS), runs an LLM summarisation pipeline, and sends 13 kinds of feature-tagged Telegram alerts; also ETF and mutual-fund pollers.",
  },
  {
    id: "gdp-macro-dashboard", name: "GDP Macro Dashboard", repo: "dheerajburli86/GDP-Macro-Dashboard", branch: "main", live: null,
    summary: "India GDP nowcast dashboard (React/Vite/Recharts): 53 monthly indicators grouped into Consumption, Investment, Government, Net Exports and Cross-Cutting; shows dummy data until a feed is connected.",
  },
];
const IDS = PROJECTS.map((p) => p.id);
const byId = new Map(PROJECTS.map((p) => [p.id, p]));

/** Turns the request's `projects` field into a validated list of ids (possibly empty). */
function resolveSelection(input) {
  if (input === "all" || (Array.isArray(input) && input.length === 1 && input[0] === "all")) return [...IDS];
  // [] is allowed and means "general only": answer from knowledge and the web, read no project.
  if (!Array.isArray(input))
    throw new HttpError(400, 'projects is required: an array of project ids ([] for none), or "all".');
  const out = [];
  for (const raw of input) {
    const id = String(raw || "").trim().toLowerCase();
    if (id === "all") return [...IDS];
    if (!byId.has(id)) throw new HttpError(400, `Unknown project "${String(raw).slice(0, 40)}". Known: ${IDS.join(", ")}.`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** The PROJECTS.md section for one project (## heading through the next ##). */
let docCache = null;
function projectDoc(id) {
  if (!docCache) {
    try { docCache = fs.readFileSync(path.join(__dirname, "..", "docs", "PROJECTS.md"), "utf8"); } catch { docCache = ""; }
  }
  const parts = docCache.split(/\n(?=## )/);
  const sec = parts.find((s) => s.startsWith("## ") && s.includes(`(\`${id}\`)`));
  return sec ? sec.trim() : "";
}

module.exports = { PROJECTS, IDS, byId, resolveSelection, projectDoc };
