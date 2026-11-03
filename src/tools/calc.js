"use strict";
// `calculate`: exact maths without any external service. Expressions are
// evaluated by mathjs (arithmetic, algebra, units, matrices, statistics,
// probability) plus a few finance functions, in a worker thread with a hard
// memory cap and a timeout, so `zeros(1e5,1e5)` or a pathological expression
// cannot take the server down. mathjs's code-loading functions are disabled
// inside the worker.
const path = require("path");
const { Worker } = require("worker_threads");

const MAX_EXPR = 4000;
const TIMEOUT_MS = 4000;

function evaluateIsolated(expressions, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const w = new Worker(path.join(__dirname, "calcWorker.js"), {
      workerData: { expressions },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      env: {}, // the worker sees no environment variables (no keys)
    });
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); w.terminate().catch(() => {}); resolve(v); } };
    const t = setTimeout(() => finish({ error: `calculation took longer than ${timeoutMs / 1000}s and was stopped` }), timeoutMs);
    w.once("message", finish);
    w.once("error", (e) => finish({ error: /memory|heap/i.test(String(e && e.message)) ? "calculation needed too much memory and was stopped" : String(e && e.message || e).slice(0, 200) }));
    w.once("exit", (code) => finish({ error: `calculation stopped (exit ${code})` }));
  });
}

const tool = {
  name: "calculate",
  description: [
    "Exact calculator (mathjs). Use it for any non-trivial arithmetic, percentages, statistics, unit conversion, algebra or finance maths, instead of doing it in your head.",
    "Pass one expression per line; earlier lines can define variables used later (e.g. 'r = 0.12' then 'fv(r/12, 60, -10000, 0)').",
    "Available: + - * / ^ %, sqrt, log, exp, round(x, n), sum, mean, median, std, variance, min, max, quantileSeq, combinations, factorial, matrices [1,2;3,4], det, inv, unit conversion ('5 km to mile', '100 degF to degC').",
    "Finance (rates per period as decimals; cash paid out is negative): cagr(start, end, years), npv(rate, [cf0, cf1, ...]) with cf0 at time 0, irr([cf0, cf1, ...]), pmt(rate, nper, pv, fv?), fv(rate, nper, pmt, pv?), pv(rate, nper, pmt, fv?), effectiveRate(nominal, periodsPerYear).",
  ].join(" "),
  parameters: {
    type: "object",
    properties: { expression: { type: "string", description: "one or more mathjs expressions, one per line" } },
    required: ["expression"],
  },
  async run(a) {
    const src = String(a.expression || "").slice(0, MAX_EXPR);
    if (!src.trim()) return { error: "expression is required" };
    const lines = src.split(/\r?\n|;(?![^[]*\])/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 60) return { error: "at most 60 lines per call" };
    return evaluateIsolated(lines);
  },
};

module.exports = { tool, evaluateIsolated };
