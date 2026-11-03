"use strict";
// Primary-source company disclosures, from fixed official hosts (the model never
// chooses a URL here):
//   india  NSE corporate announcements (results, board outcomes, concall
//          transcripts, investor presentations, ...), falling back to BSE.
//   us     SEC EDGAR: the filing list (10-K, 10-Q, 8-K, 20-F, 6-K, proxy ...) and,
//          on request, key reported figures (revenue, profit, balance sheet,
//          cash flow) from the XBRL company facts.
// Every result carries links to the original documents; PDFs are read with web_fetch.
const { clamp } = require("./util");

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const DEFAULT_SEC_UA = "GQuants Agent research (set SEC_USER_AGENT to 'Company name contact@email')";
const TIMEOUT = 15000;

const CATEGORY = {
  results: /financial result|results? for|outcome of board meeting|audited|unaudited|quarterly result|annual result/i,
  concall: /con\.? ?call|conference call|earnings call|transcript|analysts?\/?institutional|investor meet|analyst meet|audio recording/i,
  presentation: /presentation|investor (deck|update)|press release/i,
  board: /board meeting|outcome|record date|dividend|buy ?back|bonus|split/i,
  shareholding: /shareholding|pledge|insider|sast|substantial acquisition|encumbrance/i,
  management: /resignation|appointment|change in (director|management|kmp|auditor)|cessation|ceo|cfo|managing director/i,
  rating: /credit rating|rating/i,
  deals: /acquisition|amalgamation|merger|demerger|scheme of arrangement|order|contract|agreement|joint venture|allotment/i,
  legal: /litigation|penalty|show cause|sebi|regulatory|tax|court|tribunal|nclt|fraud|default/i,
};

const pad = (n) => String(n).padStart(2, "0");
const ddmmyyyy = (d) => `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
const yyyymmdd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const istNow = (now) => new Date(now.getTime() + 5.5 * 3600e3);
const trim = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

async function req(f, url, headers, type = "json") {
  const r = await f(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) { const e = new Error(`HTTP ${r.status} from ${new URL(url).host}`); e.status = r.status; throw e; }
  return type === "json" ? r.json() : r.text();
}

// ------------------------------------------------------------------ India: NSE
const nseCookie = { value: "", at: 0 };
async function nseHeaders(f, now) {
  if (!nseCookie.value || now - nseCookie.at > 10 * 60e3) {
    const r = await f("https://www.nseindia.com/", { headers: { "user-agent": BROWSER_UA, accept: "text/html", "accept-language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(TIMEOUT) });
    const raw = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie")].filter(Boolean);
    nseCookie.value = raw.map((c) => String(c).split(";")[0]).filter(Boolean).join("; ");
    nseCookie.at = now;
  }
  return { "user-agent": BROWSER_UA, accept: "application/json, text/plain, */*", "accept-language": "en-US,en;q=0.9", referer: "https://www.nseindia.com/", cookie: nseCookie.value };
}

async function nseSymbol(f, q, headers) {
  const raw = String(q).trim();
  if (/^[A-Z0-9&-]{1,20}$/.test(raw)) return { symbol: raw, name: null };
  const j = await req(f, `https://www.nseindia.com/api/search/autocomplete?q=${encodeURIComponent(raw)}`, headers);
  const hit = (j.symbols || []).find((s) => s.symbol && (!s.result_sub_type || /equity/i.test(s.result_sub_type))) || (j.symbols || [])[0];
  if (!hit || !hit.symbol) throw new Error(`NSE has no listed company matching "${raw}"`);
  return { symbol: hit.symbol, name: hit.symbol_info || null };
}

async function nseAnnouncements(f, q, from, to, now) {
  const headers = await nseHeaders(f, now);
  const sym = await nseSymbol(f, q, headers);
  const j = await req(f, `https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(sym.symbol)}&from_date=${ddmmyyyy(from)}&to_date=${ddmmyyyy(to)}`, headers);
  const rows = Array.isArray(j) ? j : (j && j.data) || [];
  return {
    exchange: "NSE", company: sym.name || (rows[0] && rows[0].sm_name) || sym.symbol, symbol: sym.symbol,
    items: rows.map((r) => ({
      date: r.an_dt || r.sort_date || r.dt || null,
      subject: trim(r.desc, 160),
      details: trim(r.attchmntText, 400),
      pdf: r.attchmntFile && /^https?:/.test(r.attchmntFile) ? r.attchmntFile : null,
      _text: `${r.desc || ""} ${r.attchmntText || ""}`,
    })),
  };
}

// ------------------------------------------------------------------ India: BSE
const BSE_HEADERS = { "user-agent": BROWSER_UA, accept: "application/json, text/plain, */*", referer: "https://www.bseindia.com/", origin: "https://www.bseindia.com" };

async function bseScrip(f, q) {
  const raw = String(q).trim();
  if (/^\d{6}$/.test(raw)) return { code: raw, name: null };
  const html = await req(f, `https://api.bseindia.com/Msource/90D/getQouteSearch.aspx?Type=EQ&text=${encodeURIComponent(raw)}&flag=site`, BSE_HEADERS, "text");
  const m = /(\d{6})/.exec(html);
  if (!m) throw new Error(`BSE has no listed company matching "${raw}"`);
  const name = /<strong>([^<]+)<\/strong>/i.exec(html) || />\s*([^<>]{3,80}?)\s*</.exec(html);
  return { code: m[1], name: name ? trim(name[1], 80) : null };
}

async function bseAnnouncements(f, q, from, to) {
  const s = await bseScrip(f, q);
  const j = await req(f, `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?pageno=1&strCat=-1&strPrevDate=${yyyymmdd(from)}&strScrip=${s.code}&strSearch=P&strToDate=${yyyymmdd(to)}&strType=C&subcategory=-1`, BSE_HEADERS);
  const rows = (j && j.Table) || [];
  return {
    exchange: "BSE", company: s.name || (rows[0] && rows[0].SLONGNAME) || s.code, scrip_code: s.code,
    items: rows.map((r) => ({
      date: r.NEWS_DT || r.DissemDT || null,
      subject: trim(r.NEWSSUB || r.HEADLINE, 160),
      details: trim(r.HEADLINE && r.HEADLINE !== r.NEWSSUB ? r.HEADLINE : "", 400),
      category: r.CATEGORYNAME || undefined,
      pdf: r.ATTACHMENTNAME ? `https://www.bseindia.com/xml-data/corpfiling/${Number(r.PDFFLAG) === 1 ? "AttachHis" : "AttachLive"}/${r.ATTACHMENTNAME}` : null,
      _text: `${r.NEWSSUB || ""} ${r.HEADLINE || ""} ${r.CATEGORYNAME || ""}`,
    })),
  };
}

async function india(a, f, now) {
  const days = clamp(a.days, 1, 365, 30);
  const to = istNow(now), from = new Date(to.getTime() - days * 864e5);
  const ex = String(a.exchange || "auto").toLowerCase();
  const errors = [];
  let out = null;
  if (ex !== "bse") {
    try { out = await nseAnnouncements(f, a.company, from, to, now.getTime()); }
    catch (e) { errors.push(`NSE: ${e.message}`); }
  }
  if (!out && ex !== "nse") {
    try { out = await bseAnnouncements(f, a.company, from, to); }
    catch (e) { errors.push(`BSE: ${e.message}`); }
  }
  if (!out) return { error: `could not read exchange announcements (${errors.join("; ")})`, hint: "Try the other exchange (exchange='bse' with the 6-digit scrip code, or 'nse' with the NSE symbol), or fall back to web_research / web_search for the filing." };
  return finish(out, a, days, "Exchange filing (primary source)");
}

// ------------------------------------------------------------------ US: SEC EDGAR
const tickers = { map: null, at: 0 };
async function secCik(f, q, ua, now) {
  const raw = String(q).trim();
  if (/^\d{1,10}$/.test(raw)) return { cik: raw.padStart(10, "0"), name: null, ticker: null };
  if (!tickers.map || now - tickers.at > 24 * 3600e3) {
    const j = await req(f, "https://www.sec.gov/files/company_tickers.json", { "user-agent": ua, accept: "application/json" });
    tickers.map = Object.values(j).map((r) => ({ cik: String(r.cik_str).padStart(10, "0"), ticker: String(r.ticker).toUpperCase(), name: r.title }));
    tickers.at = now;
  }
  const t = raw.toUpperCase().replace(/\./g, "-");
  const exact = tickers.map.find((r) => r.ticker === t);
  if (exact) return exact;
  const low = raw.toLowerCase();
  const byName = tickers.map.find((r) => r.name.toLowerCase() === low)
    || tickers.map.find((r) => r.name.toLowerCase().startsWith(low))
    || tickers.map.find((r) => r.name.toLowerCase().includes(low));
  if (!byName) throw new Error(`SEC has no registrant matching "${raw}" (non-US companies listed only abroad do not file with the SEC)`);
  return byName;
}

const CONCEPTS = [
  ["revenue", ["us-gaap:Revenues", "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "us-gaap:SalesRevenueNet", "ifrs-full:Revenue"]],
  ["operating_income", ["us-gaap:OperatingIncomeLoss", "ifrs-full:ProfitLossFromOperatingActivities"]],
  ["net_income", ["us-gaap:NetIncomeLoss", "ifrs-full:ProfitLossAttributableToOwnersOfParent", "ifrs-full:ProfitLoss"]],
  ["eps_diluted", ["us-gaap:EarningsPerShareDiluted", "ifrs-full:DilutedEarningsLossPerShare"]],
  ["total_assets", ["us-gaap:Assets", "ifrs-full:Assets"]],
  ["total_liabilities", ["us-gaap:Liabilities", "ifrs-full:Liabilities"]],
  ["shareholders_equity", ["us-gaap:StockholdersEquity", "ifrs-full:EquityAttributableToOwnersOfParent", "ifrs-full:Equity"]],
  ["cash", ["us-gaap:CashAndCashEquivalentsAtCarryingValue", "ifrs-full:CashAndCashEquivalents"]],
  ["long_term_debt", ["us-gaap:LongTermDebtNoncurrent", "us-gaap:LongTermDebt", "ifrs-full:NoncurrentFinancialLiabilities"]],
  ["operating_cash_flow", ["us-gaap:NetCashProvidedByUsedInOperatingActivities", "ifrs-full:CashFlowsFromUsedInOperatingActivities"]],
  ["capex", ["us-gaap:PaymentsToAcquirePropertyPlantAndEquipment", "ifrs-full:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"]],
];
const REPORT_FORMS = /^(10-K|10-Q|20-F|40-F)(\/A)?$/;

/** Picks the latest reported values of one concept, one per period, newest first. */
function series(facts, names, n) {
  for (const full of names) {
    const [ns, name] = full.split(":");
    const c = facts[ns] && facts[ns][name];
    if (!c || !c.units) continue;
    const unit = Object.keys(c.units)[0];
    const best = new Map();
    for (const v of c.units[unit]) {
      if (!REPORT_FORMS.test(v.form || "") || v.val === undefined) continue;
      const k = `${v.start || ""}|${v.end}`;
      const prev = best.get(k);
      if (!prev || String(v.filed) > String(prev.filed)) best.set(k, v);
    }
    const rows = [...best.values()].sort((a, b) => String(b.end).localeCompare(String(a.end)) || String(b.start || "").localeCompare(String(a.start || ""))).map((v) => {
      let period = "as of";
      if (v.start) {
        const d = (Date.parse(v.end) - Date.parse(v.start)) / 864e5;
        period = d < 100 ? "quarter" : d > 300 ? "full year" : `${Math.round(d / 30)} months`;
      }
      return { period_end: v.end, period, value: v.val, form: v.form, filed: v.filed };
    });
    if (rows.length) return { concept: full, unit, values: rows.slice(0, n) };
  }
  return null;
}

async function us(a, f, now, ua) {
  const days = clamp(a.days, 1, 3650, 90);
  const co = await secCik(f, a.company, ua, now.getTime());
  const h = { "user-agent": ua, accept: "application/json" };
  const sub = await req(f, `https://data.sec.gov/submissions/CIK${co.cik}.json`, h);
  const r = (sub.filings && sub.filings.recent) || {};
  const cutoff = new Date(now.getTime() - days * 864e5).toISOString().slice(0, 10);
  const forms = String(a.forms || "").toUpperCase().split(/[\s,]+/).filter(Boolean);
  const cikNum = String(Number(co.cik));
  const items = [];
  for (let i = 0; i < (r.form || []).length && items.length < 200; i++) {
    if (r.filingDate[i] < cutoff) continue;
    if (forms.length && !forms.includes(String(r.form[i]).toUpperCase())) continue;
    const acc = String(r.accessionNumber[i]).replace(/-/g, "");
    items.push({
      date: r.filingDate[i], form: r.form[i], report_date: r.reportDate ? r.reportDate[i] || undefined : undefined,
      subject: trim(r.primaryDocDescription ? r.primaryDocDescription[i] : r.form[i], 160) || r.form[i],
      details: r.items && r.items[i] ? `8-K items: ${r.items[i]}` : "",
      url: r.primaryDocument && r.primaryDocument[i] ? `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/${r.primaryDocument[i]}` : `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/`,
      _text: `${r.form[i]} ${r.primaryDocDescription ? r.primaryDocDescription[i] : ""} ${r.items ? r.items[i] : ""}`,
    });
  }
  const out = finish({ exchange: "SEC EDGAR", company: sub.name || co.name, ticker: (sub.tickers || [])[0] || co.ticker, cik: co.cik, items }, a, days, "SEC EDGAR (primary source)");
  out.note = "8-K item codes: 2.02 results, 5.02 officer/director changes, 1.01 material agreements, 2.01 acquisitions/disposals, 8.01 other events. " + out.note;
  if (a.financials) {
    try {
      const facts = await req(f, `https://data.sec.gov/api/xbrl/companyfacts/CIK${co.cik}.json`, h);
      const n = clamp(a.periods, 1, 12, 6);
      const fin = {};
      for (const [label, names] of CONCEPTS) { const s = series(facts.facts || {}, names, n); if (s) fin[label] = s; }
      out.financials = Object.keys(fin).length ? fin : { note: "no XBRL figures reported" };
      out.financials_note = "As reported in 10-K/10-Q (or 20-F/40-F) XBRL, latest amendment wins. 'quarter' values are three months; 'N months' are year-to-date. Use calculate for growth rates and margins.";
    } catch (e) { out.financials = { error: `could not read reported figures: ${e.message}` }; }
  }
  return out;
}

// ------------------------------------------------------------------ shared
function finish(out, a, days, source) {
  const cat = String(a.category || "all").toLowerCase();
  const re = CATEGORY[cat];
  const text = String(a.contains || "").trim().toLowerCase();
  let items = out.items;
  if (re) items = items.filter((x) => re.test(x._text));
  if (text) items = items.filter((x) => x._text.toLowerCase().includes(text));
  const max = clamp(a.limit, 1, 60, 25);
  const total = items.length;
  items = items.slice(0, max).map(({ _text, ...rest }) => Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== "" && v !== null)));
  return {
    source, ...out, items, window_days: days, category: re ? cat : "all", matched: total, shown: items.length,
    note: `${total ? "" : "Nothing matched in this window. "}Open a document (PDF or HTML) with web_fetch to read it; quote the date and link.`,
  };
}

const tool = {
  name: "company_filings",
  description: "Official company disclosures straight from the source. market='india': NSE corporate announcements (falls back to BSE) — quarterly results, board-meeting outcomes, earnings-call/concall transcripts and audio, investor presentations, credit ratings, management changes, orders, M&A, shareholding and insider disclosures — each with its PDF link. market='us': SEC EDGAR filings (10-K, 10-Q, 8-K, 20-F, 6-K, proxy ...), and with financials=true the reported revenue, operating income, net income, EPS, assets, liabilities, equity, cash, debt, operating cash flow and capex by period. Prefer this over news for what a company itself disclosed. For other countries, use web_research or web_search.",
  parameters: {
    type: "object",
    properties: {
      market: { type: "string", enum: ["india", "us"] },
      company: { type: "string", description: "india: NSE symbol (e.g. HDFCBANK), BSE 6-digit scrip code, or company name. us: ticker (e.g. AAPL), company name, or CIK" },
      days: { type: "integer", description: "look-back window in days (india default 30, max 365; us default 90)" },
      category: { type: "string", enum: ["all", ...Object.keys(CATEGORY)], description: "filter: results, concall (transcripts, analyst meets), presentation, board, shareholding, management, rating, deals, legal" },
      contains: { type: "string", description: "optional text the subject must contain" },
      exchange: { type: "string", enum: ["auto", "nse", "bse"], description: "india only; default auto (NSE, then BSE)" },
      forms: { type: "string", description: "us only: comma-separated forms to keep, e.g. 10-Q,8-K" },
      financials: { type: "boolean", description: "us only: include reported financial figures" },
      periods: { type: "integer", description: "us financials: periods per figure, default 6" },
      limit: { type: "integer", description: "max items, default 25" },
    },
    required: ["market", "company"],
  },
  async run(a, ctx) {
    const f = ctx.fetch || fetch;
    const now = ctx.now ? ctx.now() : new Date();
    if (!String(a.company || "").trim()) return { error: "company is required" };
    try {
      if (a.market === "india") return await india(a, f, now);
      if (a.market === "us") return await us(a, f, now, ctx.secUserAgent || DEFAULT_SEC_UA);
      return { error: "market must be india or us; for other countries use web_research or web_search" };
    } catch (e) {
      return { error: e.message, hint: a.market === "us" && e.status === 403 ? "SEC refused the request: set SEC_USER_AGENT to 'Company name contact@email'." : "Fall back to web_research / web_search for this filing." };
    }
  },
};

/** For tests: forget cached cookies and the ticker list. */
function _reset() { nseCookie.value = ""; nseCookie.at = 0; tickers.map = null; tickers.at = 0; }

module.exports = { tool, CATEGORY, series, _reset, DEFAULT_SEC_UA };
