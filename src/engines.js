"use strict";
// Which AI does the work, chosen by the person in the message itself:
//
//   (no tag)      DeepInfra (Gemini) alone. Grok is NOT used, not even for search.
//   @deepinfra    DeepInfra alone (same as no tag, said explicitly).
//   @grok         Grok alone, with Grok's live web search.
//   @grok @deepinfra  (or @both)
//                 both work on the question at the same time, independently;
//                 then DeepInfra merges the two answers into one.
//
// If the key for the chosen engine is missing, the person is told so plainly.
// The one exception: with no tag and no DeepInfra key at all, Grok is used, so a
// Grok-only setup still answers.
const deepinfra = require("./providers/deepinfra");
const { withFallback, GROK_URL } = require("./providers/index");
const { runAgent } = require("./agent");

const TAG_GROK = /(^|[\s(,])@grok\b(?![_\w])/gi;
const TAG_DEEP = /(^|[\s(,])@deep-?infra\b(?![_\w])/gi;
const TAG_BOTH = /(^|[\s(,])@both\b(?![_\w])/gi;

/** Reads the engine tags out of a message. Returns { mode, text } with the tags removed. */
function parseEngines(text) {
  const t = String(text || "");
  const g = new RegExp(TAG_GROK.source, "i").test(t);
  const d = new RegExp(TAG_DEEP.source, "i").test(t);
  const b = new RegExp(TAG_BOTH.source, "i").test(t);
  const mode = b || (g && d) ? "both" : g ? "grok" : d ? "deepinfra" : "default";
  const clean = t.replace(TAG_GROK, "$1").replace(TAG_DEEP, "$1").replace(TAG_BOTH, "$1").replace(/[ \t]{2,}/g, " ").trim();
  return { mode, text: clean };
}

/** Builds each engine separately (no silent cross-provider fallback). */
function createEngines(cfg, fetchImpl = fetch) {
  const mk = (o) => deepinfra.create({ fetchImpl, maxTokens: cfg.maxOutputTokens, ...o });
  let dInfra = null, grok = null;
  if (cfg.deepinfraKey) {
    const main = mk({ apiKey: cfg.deepinfraKey, model: cfg.model, url: cfg.deepinfraUrl });
    const backup = cfg.fallbackModel && cfg.fallbackModel !== cfg.model ? mk({ apiKey: cfg.deepinfraKey, model: cfg.fallbackModel, url: cfg.deepinfraUrl }) : null;
    dInfra = withFallback(main, backup);
  }
  if (cfg.xaiKey) grok = mk({ apiKey: cfg.xaiKey, model: cfg.grokModel, url: GROK_URL, name: "grok" });
  return { deepinfra: dInfra, grok };
}

const LABEL = { default: "DeepInfra", deepinfra: "DeepInfra", grok: "Grok", both: "Grok + DeepInfra" };

/** Which engines a mode needs, or a plain-words reason it can't run. */
function plan(mode, engines) {
  const has = (k) => !!engines[k];
  if (mode === "grok") return has("grok") ? { use: ["grok"] } : { error: "Grok isn't set up on this bot yet (the admin needs to add XAI_API_KEY). Ask again without @grok and I'll answer with DeepInfra." };
  if (mode === "deepinfra") return has("deepinfra") ? { use: ["deepinfra"] } : { error: "DeepInfra isn't set up on this bot yet (the admin needs to add DEEPINFRA_API_KEY)." };
  if (mode === "both") {
    if (has("grok") && has("deepinfra")) return { use: ["deepinfra", "grok"] };
    return { error: `Both engines are needed for that, but ${has("grok") ? "DeepInfra" : "Grok"} isn't set up yet (the admin needs to add ${has("grok") ? "DEEPINFRA_API_KEY" : "XAI_API_KEY"}).` };
  }
  if (has("deepinfra")) return { use: ["deepinfra"] };
  if (has("grok")) return { use: ["grok"] };
  return { error: "I'm not fully set up yet. Please let the admin know." };
}

const MERGE_SYSTEM = `You combine two AI answers to the same question into ONE answer for the person who asked.
- Keep every correct, useful point from both; drop repetition.
- Where they disagree on a fact or number, prefer the one backed by a source or a date and say briefly that the other differed. Never invent a figure that is in neither answer.
- Keep the source links and dates that either answer gave.
- Follow the style rules of the original answers: plain words, short, Telegram-friendly, no HTML, no buy/sell/hold advice. Reply in the language the question was asked in.
- Do not mention "answer A", "answer B", or which AI wrote what. Just give the combined answer.`;

/**
 * Runs the question on the chosen engine(s). buildTools(useGrokResearch) returns the tool list;
 * buildSystem(toolNames) returns the system prompt. Returns { answer, steps, engines, partial? }.
 */
async function runWithEngines({ mode, engines, researchTool, buildTools, buildSystem, ctx, history, message, maxSteps, deadline, checkBudget }) {
  const p = plan(mode, engines);
  if (p.error) { const e = new Error(p.error); e.userFacing = true; throw e; }
  const one = (key) => {
    const tools = buildTools(key === "grok" ? researchTool : null);
    return runAgent({ provider: engines[key], tools, ctx, history, message, system: buildSystem(tools.map((t) => t.name)), maxSteps, deadline, checkBudget });
  };
  if (p.use.length === 1) {
    const out = await one(p.use[0]);
    return { answer: out.answer, steps: out.steps, engines: p.use };
  }
  const [d, g] = await Promise.allSettled([one("deepinfra"), one("grok")]);
  const ok = (r) => r.status === "fulfilled";
  if (!ok(d) && !ok(g)) throw d.reason;
  if (!ok(d) || !ok(g)) {
    const survivor = ok(d) ? d.value : g.value;
    return { answer: survivor.answer, steps: survivor.steps, engines: [ok(d) ? "deepinfra" : "grok"], partial: true };
  }
  const merged = await engines.deepinfra.chat({
    system: MERGE_SYSTEM,
    messages: [{ role: "user", content: `QUESTION:\n${message}\n\nFIRST ANSWER:\n${d.value.answer}\n\nSECOND ANSWER:\n${g.value.answer}\n\nWrite the single combined answer.` }],
    tools: [],
  });
  if (merged.usage && ctx.usage) { ctx.usage.in += merged.usage.in || 0; ctx.usage.out += merged.usage.out || 0; }
  return { answer: merged.text || d.value.answer, steps: [...d.value.steps, ...g.value.steps], engines: ["deepinfra", "grok"] };
}

module.exports = { parseEngines, createEngines, plan, runWithEngines, LABEL, MERGE_SYSTEM };
