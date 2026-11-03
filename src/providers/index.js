"use strict";
// DeepInfra is the only model provider. AGENT_MODEL (default
// google/gemini-2.5-flash) drives the agent; AGENT_FALLBACK_MODEL, if set, is a
// second DeepInfra model (same key) tried when a call to the first fails.
// Messages carry tool calls in a provider-neutral form (`toolCalls`), so a
// conversation can switch model mid-loop.
const deepinfra = require("./deepinfra");

function withFallback(primary, fallback, log = (m) => console.error(m)) {
  if (!primary) return fallback || null;
  if (!fallback) return primary;
  const p = {
    name: `${primary.name}>${fallback.name}`,
    model: primary.model,
    lastModel: primary.model,
    async chat(args) {
      try {
        const r = await primary.chat(args);
        p.lastModel = primary.model;
        return r;
      } catch (e) {
        // A request the API itself rejects as malformed (400/401/403/404/422)
        // would fail the same way on the fallback: surface it, don't mask it.
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
        log(`[provider] ${primary.model} failed (${String(e.message || e).slice(0, 160)}); falling back to ${fallback.model}`);
        const r = await fallback.chat(args);
        p.lastModel = fallback.model;
        return { ...r, fallback: true };
      }
    },
  };
  return p;
}

const GROK_URL = "https://api.x.ai/v1/chat/completions";

/**
 * Returns the main model provider. AGENT_PROVIDER picks the primary: "deepinfra"
 * (default) or "grok". If the chosen one has no key, the other is used. Returns
 * null when neither key is set (the bot boots and says so when asked).
 */
function createProvider(cfg, fetchImpl = fetch) {
  const dInfra = () => cfg.deepinfraKey ? deepinfra.create({ apiKey: cfg.deepinfraKey, model: cfg.model, fetchImpl, maxTokens: cfg.maxOutputTokens, url: cfg.deepinfraUrl }) : null;
  const grok = () => cfg.xaiKey ? deepinfra.create({ apiKey: cfg.xaiKey, model: cfg.grokModel, fetchImpl, maxTokens: cfg.maxOutputTokens, url: GROK_URL, name: "grok" }) : null;
  const primary = cfg.agentProvider === "grok" ? (grok() || dInfra()) : (dInfra() || grok());
  if (!primary) return null;
  const fallbackOwn = cfg.fallbackModel && cfg.fallbackModel !== cfg.model && primary.name === "deepinfra"
    ? deepinfra.create({ apiKey: cfg.deepinfraKey, model: cfg.fallbackModel, fetchImpl, maxTokens: cfg.maxOutputTokens, url: cfg.deepinfraUrl }) : null;
  const other = primary.name === "deepinfra" ? grok() : dInfra();
  return withFallback(primary, fallbackOwn || other);
}

module.exports = { withFallback, createProvider, GROK_URL };
