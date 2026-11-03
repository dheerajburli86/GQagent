"use strict";
// Runs inside a worker thread with a memory cap (see calc.js). Receives
// expressions, returns formatted results. Never loads anything but mathjs.
const { parentPort, workerData } = require("worker_threads");
const { create, all } = require("mathjs");

const math = create(all, { number: "number", precision: 64 });

const flat = (x) => {
  const v = x && typeof x.valueOf === "function" ? x.valueOf() : x;
  return (Array.isArray(v) ? v.flat(Infinity) : [v]).map(Number);
};
const npvOf = (rate, cfs) => cfs.reduce((s, c, t) => s + c / Math.pow(1 + rate, t), 0);

const finance = {
  cagr(start, end, years) {
    if (!(start > 0) || !(years > 0)) throw new Error("cagr needs start > 0 and years > 0");
    return Math.pow(end / start, 1 / years) - 1;
  },
  npv(rate, cashflows) { return npvOf(Number(rate), flat(cashflows)); },
  irr(cashflows) {
    const cfs = flat(cashflows);
    if (!cfs.some((c) => c > 0) || !cfs.some((c) => c < 0)) throw new Error("irr needs at least one positive and one negative cash flow");
    // bisection on a bracket, then it is exact to ~1e-12
    let lo = -0.9999, hi = 1, flo = npvOf(lo, cfs), fhi = npvOf(hi, cfs);
    let k = 0;
    while (flo * fhi > 0 && k++ < 60) { hi *= 2; fhi = npvOf(hi, cfs); }
    if (flo * fhi > 0) throw new Error("irr: no rate between -99.99% and the search limit gives NPV = 0");
    for (let i = 0; i < 300; i++) {
      const mid = (lo + hi) / 2, fm = npvOf(mid, cfs);
      if (Math.abs(fm) < 1e-12 || (hi - lo) / 2 < 1e-14) return mid;
      if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  },
  pmt(rate, nper, pv, fv = 0) {
    if (rate === 0) return -(pv + fv) / nper;
    const g = Math.pow(1 + rate, nper);
    return -(rate * (pv * g + fv)) / (g - 1);
  },
  fv(rate, nper, pmt, pv = 0) {
    if (rate === 0) return -(pv + pmt * nper);
    const g = Math.pow(1 + rate, nper);
    return -(pv * g + pmt * (g - 1) / rate);
  },
  pv(rate, nper, pmt, fv = 0) {
    if (rate === 0) return -(fv + pmt * nper);
    const g = Math.pow(1 + rate, nper);
    return -(fv + pmt * (g - 1) / rate) / g;
  },
  effectiveRate(nominal, periodsPerYear) { return Math.pow(1 + nominal / periodsPerYear, periodsPerYear) - 1; },
};
math.import(finance, { override: true });

// Disable everything that could load or build code (mathjs security guidance).
const off = (name) => () => { throw new Error(`${name} is disabled`); };
const evaluate = math.evaluate;
math.import({
  import: off("import"), createUnit: off("createUnit"), evaluate: off("evaluate"), parse: off("parse"),
  compile: off("compile"), simplify: off("simplify"), derivative: off("derivative"), resolve: off("resolve"),
  reviver: off("reviver"), chain: off("chain"),
}, { override: true });

const fmt = (v) => {
  if (v === undefined) return null;
  if (typeof v === "function") return "(function)";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(14)));
  return math.format(v, { precision: 14 });
};

try {
  const scope = new Map();
  const results = [];
  for (const expr of workerData.expressions) {
    try {
      results.push({ expr, result: fmt(evaluate(expr, scope)) });
    } catch (e) {
      results.push({ expr, error: String(e.message || e).slice(0, 200) });
    }
  }
  parentPort.postMessage({ results, last: results.length ? (results[results.length - 1].result ?? null) : null });
} catch (e) {
  parentPort.postMessage({ error: String(e.message || e).slice(0, 200) });
}
