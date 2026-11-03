"use strict";
// DeepInfra's OpenAI-compatible chat endpoint. The default model is
// google/gemini-2.5-flash, served by DeepInfra, so the one DeepInfra key is the
// only model credential the service needs.
const URL_ = "https://api.deepinfra.com/v1/openai/chat/completions";

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

/** Any OpenAI-compatible chat endpoint: DeepInfra (default) or xAI Grok (url, name). */
function create({ apiKey, model, fetchImpl = fetch, maxTokens = 8192, retryDelayMs = 800, url = URL_, name = "deepinfra" }) {
  async function chat({ system, messages, tools, temperature = 0.3 }) {
    const body = { model, messages: toMessages(system, messages), temperature, max_tokens: maxTokens };
    if (tools && tools.length) { body.tools = toTools(tools); body.tool_choice = "auto"; }
    let j, last;
    for (let i = 0; i < 3 && !j; i++) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90000),
        });
      } catch (e) {
        last = new ProviderError(`DeepInfra request failed: ${String(e.message || e).slice(0, 200)}`, 0);
        await new Promise((r) => setTimeout(r, retryDelayMs * (i + 1)));
        continue;
      }
      if (res.ok) { j = await res.json(); break; }
      const txt = await res.text().catch(() => "");
      last = new ProviderError(`DeepInfra ${res.status}: ${txt.slice(0, 300)}`, res.status);
      if (res.status !== 429 && res.status < 500) throw last;
      await new Promise((r) => setTimeout(r, retryDelayMs * (i + 1)));
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
