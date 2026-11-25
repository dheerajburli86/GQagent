"use strict";
// GQ XRayDar (the technical-analysis app): its calculations through its own
// server API, so every number the agent quotes is the number the app shows.
// Read-only. The server checks x-ta-secret; x-telegram-user lets "my
// watchlist" resolve to the asker's own XRayDar account when it is linked.

class XRayDarClient {
  constructor({ url, secret, fetchImpl = fetch, timeoutMs = 45000 }) {
    this.url = String(url || "").replace(/\/$/, "");
    this.secret = secret || "";
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }
  get ready() { return !!(this.url && this.secret); }

  async call(method, path, { body, telegramId } = {}) {
    const headers = { "x-ta-secret": this.secret, accept: "application/json" };
    if (body) headers["content-type"] = "application/json";
    if (telegramId && /^\d{1,20}$/.test(String(telegramId))) headers["x-telegram-user"] = String(telegramId);
    const r = await this.fetch(`${this.url}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(this.timeoutMs) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: j.error || `XRayDar answered HTTP ${r.status}` };
    return j;
  }
}

const ACTIONS = ["fields", "resolve", "stock", "chart_read", "chart_link", "compare", "screen", "market", "review", "signal_stats", "brief"];

const tool = (client) => ({
  name: "xraydar",
  description: `GQ XRayDar, the team's technical-analysis app: its own stored calculations for stocks, ETFs and indices in India, the US and ~39 other countries. Use it for any technical question (MMA / moving-average alignment, RSI, MACD, KST, ROC, ADX, Bollinger and other indicators, trends, stages, breakouts, chart patterns, relative strength / RSC, GLOCOM / LOCOM bands, Weight Watcher, setup score, IMB / ETI characteristics, market breadth and regime) and for stock lists filtered on those values.
Actions:
- fields {search?, group?}: the screenable fields (key, label, type, allowed values). ALWAYS look up the exact field keys here before a screen. Per-timeframe fields end in D, W, M, Q, N (9 months) or Y, e.g. mmaBullW, rsiD, kstCrossM.
- resolve {query}: find an instrument by symbol or name.
- stock {ref}: the full technical picture of one instrument (ref = symbol or id).
- chart_read {ref, tfs?}: a plain-language chart read for timeframes, e.g. "D,W".
- chart_link {ref, screen?, tf?, tf2?, bench?, country?}: a link that opens one chart on the dashboard exactly as asked. screen = chart (Chart lab, the default), stock (the stock page) or RSIMMA / RSIACC / RSCMMA / RSCACC; tf = period (D, W, M, Q, H, N, Y, or e.g. 2M); on the RSI/RSC screens tf is the left window and tf2 the right; bench = what an RSC screen compares against (a stock, an index such as "Nifty 50" or "S&P 500", or a house index key such as CW|USD|G); country picks between same-symbol listings. Returns {url}; if it returns candidates, ask which one.
- compare {a, b}: two instruments side by side.
- screen {conditions?, scope?, sort?, limit?, columns?}: stocks matching ALL conditions (conditions may be empty for a pure ranking, e.g. scope {country} + sort {field: capUsd, dir: desc}). A condition is {field, op, value?, value2?}; op is one of > >= < <= between is "is not" in contains "is true" "is false" "is set". Money fields (capUsd) are in US dollars (10 billion = 10000000000). scope narrows by {country, region, classification, sector, industryGroup, cap, assetClass}. sort = {field, dir: "desc"|"asc"}. columns = extra field keys to return per row.
- market {query}: index levels, breadth, regime and rotation. query: G (global), R:<region> or C:<country>, e.g. C:India, C:United States.
- review {symbols? | watchlist?, question?}: which names in a list are rising, with evidence.
- signal_stats: back-test summary of the signals. brief {period: daily|weekly}: the market brief text.
Always give the as-of date from the result. Do not quote a field you did not get back.
LINKS: stock, chart_read, market and every screen row come back with a dashboard link (links.chart, link, chart). Whenever an answer is about a particular instrument or chart, end it with that link as a markdown link, e.g. [Open RELIANCE chart](url); for a screen, link each listed name. When the person asks to see or open a chart or a screen, call chart_link and give its url. Never write a dashboard URL yourself; use only urls the tool returned.`,
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ACTIONS },
      search: { type: "string" }, group: { type: "string" },
      query: { type: "string" }, ref: { type: "string" }, tfs: { type: "string" },
      screen: { type: "string" }, tf: { type: "string" }, tf2: { type: "string" }, bench: { type: "string" }, country: { type: "string" },
      a: { type: "string" }, b: { type: "string" },
      conditions: { type: "array", items: { type: "object", properties: { field: { type: "string" }, op: { type: "string" }, value: { type: "string" }, value2: { type: "string" } } } },
      scope: { type: "object", properties: { country: { type: "string" }, region: { type: "string" }, classification: { type: "string" }, sector: { type: "string" }, industryGroup: { type: "string" }, cap: { type: "string" }, assetClass: { type: "string" } } },
      sort: { type: "object", properties: { field: { type: "string" }, dir: { type: "string", enum: ["desc", "asc"] } } },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      columns: { type: "array", items: { type: "string" } },
      symbols: { type: "array", items: { type: "string" } }, watchlist: { type: "string" }, question: { type: "string" },
      period: { type: "string", enum: ["daily", "weekly"] },
    },
    required: ["action"],
  },
  async run(a = {}, ctx = {}) {
    if (ctx.projectsUsed) ctx.projectsUsed.add("gq-xraydar");
    const tg = ctx.member && ctx.member.telegramId;
    const enc = encodeURIComponent;
    switch (a.action) {
      case "fields": return client.call("GET", `/api/fields?search=${enc(a.search || "")}&group=${enc(a.group || "")}`);
      case "resolve": return client.call("GET", `/api/resolve?q=${enc(a.query || a.ref || "")}`);
      case "stock": return client.call("GET", `/api/stock/${enc(a.ref || a.query || "")}`);
      case "chart_read": return client.call("GET", `/api/chart-read/${enc(a.ref || a.query || "")}?tfs=${enc(a.tfs || "D,W")}`);
      case "chart_link": {
        const q = new URLSearchParams();
        for (const k of ["ref", "screen", "tf", "tf2", "bench", "country"]) if (a[k]) q.set(k, String(a[k]));
        if (!a.ref && a.query) q.set("ref", String(a.query));
        if (!q.get("ref")) return { error: "give ref: the symbol or name of the instrument" };
        return client.call("GET", `/api/chart-link?${q}`);
      }
      case "compare": return client.call("GET", `/api/compare?a=${enc(a.a || "")}&b=${enc(a.b || "")}`);
      case "screen": {
        // a ranking alone is a valid screen ("top 5 US stocks by market cap": scope + sort, no condition)
        const conds = Array.isArray(a.conditions) ? a.conditions : [];
        if (!conds.length && !a.sort && !(a.scope && Object.keys(a.scope).length)) return { error: "give a condition, a scope or a sort; look the field keys up with action=fields first" };
        return client.call("POST", "/api/screen", { body: { conditions: conds, scope: a.scope || {}, sort: a.sort, limit: a.limit || 25, columns: a.columns || [] } });
      }
      case "market": return client.call("GET", `/api/market?scope=${enc(a.query || "G")}`);
      case "review": return client.call("POST", "/api/review", { body: { symbols: a.symbols, watchlist: a.watchlist, question: a.question }, telegramId: tg });
      case "signal_stats": return client.call("GET", "/api/signal-stats");
      case "brief": return client.call("GET", `/api/brief?period=${enc(a.period || "daily")}`);
      default: return { error: `unknown action; use one of ${ACTIONS.join(", ")}` };
    }
  },
});

function makeTools(selected, client) {
  if (!client || !client.ready || !selected.includes("gq-xraydar")) return [];
  return [tool(client)];
}

module.exports = { XRayDarClient, makeTools, ACTIONS };
