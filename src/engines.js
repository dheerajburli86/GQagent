"use strict";
// Grok (xAI) answers every question. It always has the web_research tool (Grok's
// live web search) next to the database, repo and data tools, so it can answer
// from the team's databases, the live web, or both.
//
// Old engine tags (@grok, @deepinfra, @both) are still accepted and simply
// removed from the message, so habits and saved tasks keep working.
const { createProvider } = require("./providers/index");
const { runAgent } = require("./agent");

const TAGS = /(^|[\s(,])@(grok|deep-?infra|both)\b(?![_\w])/gi;

/** Removes any old engine tag. Returns { mode: "default", text }. */
function parseEngines(text) {
  const clean = String(text || "").replace(TAGS, "$1").replace(/[ \t]{2,}/g, " ").trim();
  return { mode: "default", text: clean };
}

function createEngines(cfg, fetchImpl = fetch) {
  return { grok: createProvider(cfg, fetchImpl) };
}

const LABEL = { default: "Grok", grok: "Grok" };

function plan(_mode, engines) {
  return engines && engines.grok ? { use: ["grok"] } : { error: "I'm not fully set up yet (the admin needs to add XAI_API_KEY). Please let the admin know." };
}

/**
 * Runs the question on Grok. buildTools(researchTool) returns the tool list;
 * buildSystem(toolNames) returns the system prompt. Returns { answer, steps, engines }.
 */
async function runWithEngines({ mode, engines, researchTool, buildTools, buildSystem, ctx, history, message, maxSteps, deadline, checkBudget }) {
  const p = plan(mode, engines);
  if (p.error) { const e = new Error(p.error); e.userFacing = true; throw e; }
  const tools = buildTools(researchTool || null);
  const out = await runAgent({ provider: engines.grok, tools, ctx, history, message, system: buildSystem(tools.map((t) => t.name)), maxSteps, deadline, checkBudget });
  return { answer: out.answer, steps: out.steps, engines: ["grok"] };
}

module.exports = { parseEngines, createEngines, plan, runWithEngines, LABEL };
