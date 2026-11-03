"use strict";
// Read-only views of the dashboard's data. Every tool issues SELECTs (or the
// read-only RPCs from 20261101_team_agent_rpcs.sql) against a fixed set of
// tables; nothing here can write, and no table name comes from the model.
const { clamp, num, cleanText, pick, UUID, round } = require("./util");

const UNIVERSES = ["india_stocks", "india_etfs", "india_indices", "us_stocks", "us_etfs", "us_indices",
  "global", "global_etfs", "global_indices", "crypto", "crypto_etfs", "commodities", "currency_etf"];
const SECTOR_NOTE = "sector/industry here are the labels stored in the database. The dashboard tiles regroup stocks into 11 GICS sectors, so a stock can sit under a different sector on screen.";
const idArg = { type: "string", description: "instrument_id (UUID) from find_instrument" };
const needId = (a) => (UUID.test(String(a.instrument_id || "")) ? null : { error: "instrument_id must be a UUID from find_instrument" });

const must = (r) => { if (r.error) throw new Error(r.error.message || "database error"); return r.data; };

const tools = [
  {
    name: "find_instrument",
    description: "Look up stocks, ETFs, indices, crypto etc. by ticker or name. Always call this first to get an instrument_id.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "ticker or part of the company name" },
        universe: { type: "string", enum: UNIVERSES, description: "optional filter" },
        limit: { type: "integer", description: "1-15, default 8" },
      },
      required: ["query"],
    },
    async run(a, { sb }) {
      const q = cleanText(a.query);
      if (!q) return { error: "query is required" };
      const lim = clamp(a.limit, 1, 15, 8);
      const base = () => {
        let s = sb.from("instruments").select("id,symbol,name,universe,type,sector,industry,country,currency,market_cap_usd").eq("is_active", true);
        if (a.universe && UNIVERSES.includes(a.universe)) s = s.eq("universe", a.universe);
        return s;
      };
      const [bySym, byName] = await Promise.all([base().ilike("symbol", `${q}%`).limit(lim), base().ilike("name", `%${q}%`).limit(lim)]);
      const seen = new Set(); const rows = [];
      for (const r of [...(must(bySym) || []), ...(must(byName) || [])]) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
      rows.sort((x, y) => (y.symbol.toLowerCase() === q.toLowerCase()) - (x.symbol.toLowerCase() === q.toLowerCase()));
      return { matches: rows.slice(0, lim).map((r) => ({ instrument_id: r.id, ...r, id: undefined })), note: SECTOR_NOTE };
    },
  },
  {
    name: "get_instrument",
    description: "Latest price, returns for every window (1d to all-time), market cap and the company profile note for one instrument. Includes the as_of date of the price.",
    parameters: { type: "object", properties: { instrument_id: idArg }, required: ["instrument_id"] },
    async run(a, { sb }) {
      const bad = needId(a); if (bad) return bad;
      const RET = "price_native,price_usd,currency,as_of,ret_1d,ret_1w,ret_1m,ret_3m,ret_6m,ret_ytd,ret_1y,ret_5y,ret_10y,ret_all,glocom_label,last_price,last_price_date,ret_1d_lp";
      const [ins, r2] = await Promise.all([
        sb.from("instruments").select("symbol,name,universe,type,sector,industry,country,currency,exchange,isin,market_cap_usd,market_cap_as_of,shares_outstanding,expense_ratio,company_about").eq("id", a.instrument_id).maybeSingle(),
        sb.from("returns_latest").select(RET).eq("instrument_id", a.instrument_id).maybeSingle(),
      ]);
      const i = must(ins); if (!i) return { error: "instrument not found" };
      const r = must(r2) || {};
      const about = i.company_about ? String(i.company_about).slice(0, 1800) : undefined;
      return {
        instrument: { ...i, company_about: undefined },
        about_note: about,
        price: pick(r, ["price_native", "price_usd", "currency", "as_of"]),
        returns_percent: pick(r, ["ret_1d", "ret_1w", "ret_1m", "ret_3m", "ret_6m", "ret_ytd", "ret_1y", "ret_5y", "ret_10y", "ret_all"]),
        india_last_trade_basis: i.universe && i.universe.startsWith("india") ? pick(r, ["last_price", "last_price_date", "ret_1d_lp"]) : undefined,
        glocom: r.glocom_label || undefined,
        notes: ["Returns are percent. Price and returns are the official close as of price.as_of unless stated.", SECTOR_NOTE],
      };
    },
  },
  {
    name: "screen",
    description: "Rank instruments in one universe by a return window or by market cap, with optional filters. Use for 'top gainers', 'largest stocks in X', 'worst performers this month'. Dormant and non-company rows are excluded.",
    parameters: {
      type: "object",
      properties: {
        universe: { type: "string", enum: UNIVERSES },
        order_by: { type: "string", enum: ["ret_1d", "ret_1w", "ret_1m", "ret_3m", "ret_6m", "ret_ytd", "ret_1y", "ret_5y", "ret_all", "market_cap_usd"] },
        direction: { type: "string", enum: ["desc", "asc"], description: "desc = highest first (default)" },
        sector: { type: "string", description: "stored sector label, case-insensitive exact" },
        industry: { type: "string" },
        country: { type: "string" },
        min_market_cap_usd: { type: "number" },
        max_market_cap_usd: { type: "number" },
        min_value: { type: "number", description: "lower bound on the order_by value" },
        max_value: { type: "number", description: "upper bound on the order_by value" },
        limit: { type: "integer", description: "1-50, default 15" },
      },
      required: ["universe", "order_by"],
    },
    async run(a, { sb }) {
      if (!UNIVERSES.includes(a.universe)) return { error: "unknown universe" };
      const d = await sb.rpc("team_agent_screen", {
        p_universe: a.universe, p_order: a.order_by, p_desc: a.direction !== "asc",
        p_sector: a.sector ? cleanText(a.sector, 80) : null, p_industry: a.industry ? cleanText(a.industry, 80) : null,
        p_country: a.country ? cleanText(a.country, 60) : null,
        p_min_cap: num(a.min_market_cap_usd), p_max_cap: num(a.max_market_cap_usd),
        p_min_val: num(a.min_value), p_max_val: num(a.max_value), p_limit: clamp(a.limit, 1, 50, 15),
      });
      const rows = must(d) || [];
      return {
        order_by: a.order_by, unit: a.order_by === "market_cap_usd" ? "USD" : "percent return",
        rows: rows.map((r) => ({ instrument_id: r.instrument_id, symbol: r.symbol, name: r.name, sector: r.sector, country: r.country,
          price: round(r.price_native), currency: r.currency, market_cap_usd: r.market_cap_usd, value: round(r.val, 3), as_of: r.as_of })),
        note: SECTOR_NOTE,
      };
    },
  },
  {
    name: "market_overview",
    description: "Breadth for one universe: advancers, decliners, average and median 1-day return, and sector averages. Use for 'how is the market today'.",
    parameters: { type: "object", properties: { universe: { type: "string", enum: UNIVERSES } }, required: ["universe"] },
    async run(a, { sb }) {
      if (!UNIVERSES.includes(a.universe)) return { error: "unknown universe" };
      return { ...must(await sb.rpc("team_agent_overview", { p_universe: a.universe })), unit: "percent", note: SECTOR_NOTE };
    },
  },
  {
    name: "technical_signals",
    description: "Latest technical indicator readings from the nightly scan: RSI, MACD, trend (50/200-DMA), 52-week and all-time high/low position, across timeframes.",
    parameters: { type: "object", properties: { instrument_id: idArg }, required: ["instrument_id"] },
    async run(a, { sb }) {
      const bad = needId(a); if (bad) return bad;
      const q = (t, cols) => sb.from(t).select(cols).eq("instrument_id", a.instrument_id).limit(8);
      const [rsi, macd, trend, w52, ath] = await Promise.all([
        q("tech_indicators_rsi", "timeframe,rsi14,rsi_zone,rsi_trend,rsi_divergence,as_of_date"),
        q("tech_indicators_macd", "timeframe,macd_line,signal_line,histogram,signal,as_of_date"),
        q("tech_trend_identification", "timeframe,price_vs_50dma,price_vs_200dma,dma50_vs_200dma,all_mas_aligned,as_of"),
        q("tech_indicators_52w", "cmp,week52_high,week52_low,dist_from_high_pct,dist_from_low_pct,is_new_52w_high,is_new_52w_low,as_of_date"),
        q("tech_indicators_ath", "cmp,ath,atl,dist_from_ath_pct,dist_from_atl_pct,is_new_ath,is_new_atl,as_of_date"),
      ]);
      return { rsi: must(rsi), macd: must(macd), trend: must(trend), week52: must(w52), all_time: must(ath),
        note: "Signals are rewritten nightly; as_of_date says which session each reading is from. Describe the reading; do not turn it into a buy/sell call." };
    },
  },
  {
    name: "price_history",
    description: "Closing prices for one instrument over the last N days, downsampled to at most 90 points, with start/end/high/low and change. Use for trends; pass the numbers to calculate for statistics.",
    parameters: { type: "object", properties: { instrument_id: idArg, days: { type: "integer", description: "calendar days back, 5-1500, default 180" } }, required: ["instrument_id"] },
    async run(a, { sb }) {
      const bad = needId(a); if (bad) return bad;
      const days = clamp(a.days, 5, 1500, 180);
      const since = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
      const rows = must(await sb.from("price_history").select("date,close").eq("instrument_id", a.instrument_id).gte("date", since).order("date", { ascending: true }).limit(2000)) || [];
      if (!rows.length) return { error: "no price history in that window" };
      const step = Math.max(1, Math.ceil(rows.length / 90));
      const series = rows.filter((_, i) => i % step === 0 || i === rows.length - 1).map((r) => [r.date, round(Number(r.close), 4)]);
      const closes = rows.map((r) => Number(r.close));
      const first = closes[0], last = closes[closes.length - 1];
      return { from: rows[0].date, to: rows[rows.length - 1].date, points_total: rows.length, first, last,
        change_percent: round(((last - first) / first) * 100, 2), high: Math.max(...closes), low: Math.min(...closes), series,
        note: "Closes are split-adjusted where the data source adjusts them; India history is not adjusted for splits." };
    },
  },
  {
    name: "india_volume",
    description: "Recent daily traded volume for an Indian stock: NSE, BSE and total.",
    parameters: { type: "object", properties: { instrument_id: idArg }, required: ["instrument_id"] },
    async run(a, { sb }) {
      const bad = needId(a); if (bad) return bad;
      const rows = must(await sb.from("india_volume_daily").select("date,volume_nse,volume_bse,volume_total,primary_exchange,dual").eq("instrument_id", a.instrument_id).order("date", { ascending: false }).limit(10));
      return { rows: rows || [], unit: "shares" };
    },
  },
  {
    name: "fundamentals",
    description: "Company profile and the latest annual financials (revenue, profit, EPS, assets, debt, cash flow). May be a few months old: fundamentals refresh is currently paused.",
    parameters: { type: "object", properties: { instrument_id: idArg }, required: ["instrument_id"] },
    async run(a, { sb }) {
      const bad = needId(a); if (bad) return bad;
      const f = must(await sb.from("fundamentals").select("profile,income_statement,balance_sheet,cash_flow,status,updated_at,reported_currency").eq("instrument_id", a.instrument_id).maybeSingle());
      if (!f || f.status !== "SUCCESS") return { error: "no fundamentals stored for this instrument", status: f && f.status };
      const latest = (arr, keys, n = 2) => (Array.isArray(arr) ? arr.slice(0, n).map((x) => pick(x, keys)) : []);
      const p = f.profile || {};
      return {
        profile: { ...pick(p, ["industry", "sector", "country", "exchange", "website", "ceo", "fullTimeEmployees", "ipoDate", "beta"]), description: p.description ? String(p.description).slice(0, 700) : undefined },
        income_statement: latest(f.income_statement, ["date", "fiscalYear", "period", "revenue", "grossProfit", "operatingIncome", "netIncome", "eps", "epsDiluted"]),
        balance_sheet: latest(f.balance_sheet, ["date", "totalAssets", "totalLiabilities", "totalDebt", "cashAndCashEquivalents", "totalStockholdersEquity"]),
        cash_flow: latest(f.cash_flow, ["date", "operatingCashFlow", "capitalExpenditure", "freeCashFlow"]),
        reported_currency: f.reported_currency, updated_at: f.updated_at,
      };
    },
  },
];

module.exports = { tools, UNIVERSES };
