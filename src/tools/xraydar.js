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

const ACTIONS = ["fields", "resolve", "stock", "chart_read", "compare", "screen", "market", "review", "signal_stats", "brief"];

const tool = (client) => ({
  name: "xraydar",
  description: `GQ XRayDar, the team's technical-analysis app: its own stored calculations for stocks, ETFs and indices in India, the US and ~39 other countries. Use it for any technical question (MMA / moving-average alignment, RSI, MACD, KST, ROC, ADX, Bollinger and other indicators, trends, stages, breakouts, chart patterns, relative strength / RSC, GLOCOM / LOCOM bands, Weight Watcher, setup score, IMB / ETI characteristics, market breadth and regime) and for stock lists filtered on those values.
Actions:
- fields {search?, group?}: the screenable fields (key, label, type, allowed values). ALWAYS look up the exact field keys here before a screen. Per-timeframe fields end in D, W, M, Q, N (9 months) or Y, e.g. mmaBullW, rsiD, kstCrossM.
- resolve {query}: find an instrument by symbol or name.
- stock {ref}: the full technical picture of one instrument (ref = symbol or id).
- chart_read {ref, tfs?}: a plain-language chart read for timeframes, e.g. "D,W".
- compare {a, b}: two instruments side by side.
- screen {conditions, scope?, sort?, limit?, columns?}: stocks matching ALL conditions. A condition is {field, op, value?, value2?}; op is one of > >= < <= between is "is not" in contains "is true" "is false" "is set". Money fields (capUsd) are in US dollars (10 billion = 10000000000). scope narrows by {country, region, classification, sector, industryGroup, cap, assetClass}. sort = {field, dir: "desc"|"asc"}. columns = extra field keys to return per row.
- market {query}: index levels, breadth, regime and rotation. query: G (global), R:<region> or C:<country>, e.g. C:India, C:United States.
- review {symbols? | watchlist?, question?}: which names in a list are rising, with evidence.
- signal_stats: back-test summary of the signals. brief {period: daily|weekly}: the market brief text.
Always give the as-of date from the result. Do not quote a field you did not get back.`,
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ACTIONS },
      search: { type: "string" }, group: { type: "string" },
      query: { type: "string" }, ref: { type: "string" }, tfs: { type: "string" },
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
      case "compare": return client.call("GET", `/api/compare?a=${enc(a.a || "")}&b=${enc(a.b || "")}`);
      case "screen": {
        if (!Array.isArray(a.conditions) || !a.conditions.length) return { error: "give at least one condition; look the field keys up with action=fields first" };
        return client.call("POST", "/api/screen", { body: { conditions: a.conditions, scope: a.scope || {}, sort: a.sort, limit: a.limit || 25, columns: a.columns || [] } });
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
