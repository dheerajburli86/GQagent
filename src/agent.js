"use strict";
const { BudgetError, HttpError } = require("./errors");

const MAX_RESULT_CHARS = 12000;
const MAX_MESSAGE_CHARS = 20000; // room for a pasted document or log
const TOOL_TIMEOUT_MS = 40000;

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
}

function withTimeout(p, ms, name) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${name} timed out`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

async function runTool(tool, args, ctx) {
  const started = Date.now();
  let ok = true, result;
  try {
    result = await withTimeout(Promise.resolve(tool.run(args || {}, ctx)), TOOL_TIMEOUT_MS, tool.name);
    if (result && result.error) ok = false;
  } catch (e) {
    ok = false;
    result = { error: String(e.message || e).slice(0, 300) };
  }
  const ms = Date.now() - started;
  if (ctx.audit) { try { await ctx.audit({ tool: tool.name, args, ok, ms }); } catch { /* audit must never break a turn */ } }
  let content = JSON.stringify(result === undefined ? null : result);
  if (content.length > MAX_RESULT_CHARS) content = content.slice(0, MAX_RESULT_CHARS) + '…[truncated]"';
  return { ok, ms, content };
}

/**
 * The agent loop. Model -> (tool calls -> results -> model)* -> answer.
 * Bounded three ways: maxSteps model calls, a wall-clock deadline, and the
 * token budget checked before every model call.
 */
async function runAgent({ provider, tools, system, history, message, ctx, maxSteps = 8, deadline = Infinity, checkBudget }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const decl = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const messages = [...sanitizeHistory(history), { role: "user", content: String(message).slice(0, MAX_MESSAGE_CHARS) }];
  const steps = [];
  const usage = ctx.usage || { in: 0, out: 0 }; // shared with the caller so spend is recorded even if a turn throws
  ctx.usage = usage;
  const add = (u) => { if (u) { usage.in += u.in || 0; usage.out += u.out || 0; } };
  ctx.addUsage = add;

  for (let i = 0; i < maxSteps; i++) {
    if (Date.now() > deadline) throw new HttpError(504, "That took too long. Try a narrower question.");
    if (checkBudget) await checkBudget();
    const last = i === maxSteps - 1;
    const res = await provider.chat({ system, messages, tools: last ? [] : decl });
    add(res.usage);

    if (!res.toolCalls.length) return { answer: res.text || "(no answer)", steps, usage, messages };

    messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls, raw: res.raw });
    for (const call of res.toolCalls) {
      const tool = byName.get(call.name);
      if (!tool) {
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify({ error: `unknown tool ${call.name}` }) });
        steps.push({ tool: call.name, ok: false, ms: 0 });
        continue;
      }
      const r = await runTool(tool, call.args, ctx);
      steps.push({ tool: call.name, ok: r.ok, ms: r.ms });
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: r.content });
    }
  }
  return { answer: "I ran out of steps before finishing. Ask me a narrower question and I will continue.", steps, usage, messages };
}

module.exports = { runAgent, sanitizeHistory, runTool, BudgetError, MAX_MESSAGE_CHARS };
