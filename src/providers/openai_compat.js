"use strict";
// xAI Grok's OpenAI-compatible chat endpoint (function calling). XAI_API_KEY is
// the only model credential the service needs.
const URL_ = "https://api.x.ai/v1/chat/completions";

function toMessages(system, messages) {
  const out = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.toolCallId, name: m.name, content: m.content });
    else if (m.role === "user") out.push({ role: "user", content: m.content });
    else {
      const a = { role: "assistant", content: m.content || "" };
      if (m.toolCalls && m.toolCalls.length) {
        a.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
      }
      out.push(a);
    }
  }
  return out;
}

const SCHEMA_KEYS = new Set(["type", "description", "enum", "items", "properties", "required", "minimum", "maximum"]);
/** Keeps only the JSON-schema keys every backend (Gemini included) accepts. */
function cleanSchema(s) {
  if (Array.isArray(s)) return s.map(cleanSchema);
  if (!s || typeof s !== "object") return s;
  const o = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "properties") { o.properties = Object.fromEntries(Object.entries(v).map(([n, p]) => [n, cleanSchema(p)])); continue; }
    if (SCHEMA_KEYS.has(k)) o[k] = cleanSchema(v);
  }
  return o;
}

function toTools(tools) {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: cleanSchema(t.parameters || { type: "object", properties: {} }) } }));
}

class ProviderError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/** An OpenAI-compatible chat endpoint; xAI Grok by default. */
function create({ apiKey, model, fetchImpl = fetch, maxTokens = 8192, retryDelayMs = 800, attempts = 5, url = URL_, name = "grok" }) {
  const wait = (i, retryAfter) => {
    const ra = Number(retryAfter);
    const ms = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30000) : retryDelayMs * 2 ** i * (0.75 + Math.random() * 0.5);
    return new Promise((r) => setTimeout(r, ms));
  };
  async function chat({ system, messages, tools, temperature = 0.3 }) {
    const body = { model, messages: toMessages(system, messages), temperature, max_tokens: maxTokens };
    if (tools && tools.length) { body.tools = toTools(tools); body.tool_choice = "auto"; }
    let j, last;
    // Under load xAI answers 429 (rate limit) or 5xx. Wait and try again, honouring
    // Retry-After, with growing, jittered waits so many parallel questions do not retry in step.
    for (let i = 0; i < attempts && !j; i++) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90000),
        });
      } catch (e) {
        last = new ProviderError(`xAI request failed: ${String(e.message || e).slice(0, 200)}`, 0);
        if (i < attempts - 1) await wait(i, null);
        continue;
      }
      if (res.ok) { j = await res.json(); break; }
      const txt = await res.text().catch(() => "");
      last = new ProviderError(`xAI ${res.status}: ${txt.slice(0, 300)}`, res.status);
      if (res.status !== 429 && res.status < 500) throw last;
      if (i < attempts - 1) await wait(i, res.headers && res.headers.get ? res.headers.get("retry-after") : null);
    }
    if (!j) throw last;
    const choice = (j.choices || [])[0] || {};
    const msg = choice.message || {};
    const toolCalls = (msg.tool_calls || []).map((c, i) => {
      let args = {};
      try { args = typeof c.function.arguments === "string" ? JSON.parse(c.function.arguments || "{}") : (c.function.arguments || {}); } catch { args = {}; }
      return { id: c.id || `call_${Date.now()}_${i}`, name: c.function.name, args };
    });
    let text = typeof msg.content === "string" ? msg.content.trim() : "";
    if (!text && !toolCalls.length) {
      const why = choice.finish_reason || "no answer";
      text = why === "length"
        ? "My answer was cut off by the output limit. Ask for a shorter answer or one part at a time."
        : `I could not produce an answer (${why}). Try rephrasing the question.`;
    }
    const u = j.usage || {};
    return { text, toolCalls, usage: { in: u.prompt_tokens || 0, out: u.completion_tokens || 0 }, raw: null };
  }
  return { name, model, chat };
}

module.exports = { create, toMessages, toTools, cleanSchema, ProviderError };
