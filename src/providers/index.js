"use strict";
// xAI Grok is the only model provider. AGENT_GROK_MODEL (default grok-4.3)
// drives the agent; AGENT_FALLBACK_MODEL, if set, is a second Grok model (same
// key) tried when a call to the first fails with an outage or rate limit.
// Messages carry tool calls in a provider-neutral form (`toolCalls`).
const openai = require("./openai_compat");

function withFallback(primary, fallback, log = (m) => console.error(m)) {
  if (!primary) return fallback || null;
  if (!fallback) return primary;
  const p = {
    name: primary.name,
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

/** The Grok provider, or null when XAI_API_KEY is not set (the bot boots and says so when asked). */
function createProvider(cfg, fetchImpl = fetch) {
  if (!cfg.xaiKey) return null;
  const mk = (model) => openai.create({ apiKey: cfg.xaiKey, model, fetchImpl, maxTokens: cfg.maxOutputTokens, url: cfg.grokUrl || GROK_URL, name: "grok" });
  const backup = cfg.fallbackModel && cfg.fallbackModel !== cfg.grokModel ? mk(cfg.fallbackModel) : null;
  return withFallback(mk(cfg.grokModel), backup);
}

module.exports = { withFallback, createProvider, GROK_URL };
