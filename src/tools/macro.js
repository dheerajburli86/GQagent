"use strict";
// Macro news by country. The country list is the one on the dashboard's Global
// Indices tile: read live from the heatmap database when it is selected and
// configured, otherwise the fixed list below (the 21 countries on 2026-11-02).
//
// For each country the tool searches Google News (keyless) twice:
//   official  restricted to the country's central bank, statistics office and
//             finance ministry sites (site: filters), so rate decisions, CPI,
//             GDP and budget releases come from the source
//   press     the wider press on the country's economy, rates, inflation, GDP,
//             jobs, trade and policy
// Items from an official domain are flagged. Hosts are fixed here: the model
// picks a country and a topic, never a URL. A country outside the table still
// works with the press query only.
const { guardProject, markUsed } = require("./scope");
const { parseNewsRss } = require("./search");
const { clamp } = require("./util");

const UA = "Mozilla/5.0 (compatible; GQuantsAgent/1.0; +https://gquants.com)";

// bank / stats / ministry: who publishes the numbers. domains: where, for site: filters.
const C = (bank, stats, ministry, domains, extra = {}) => ({ bank, stats, ministry, domains, ...extra });
const COUNTRIES = {
  Argentina: C("Central Bank of Argentina (BCRA)", "INDEC", "Ministry of Economy", ["bcra.gob.ar", "indec.gob.ar", "argentina.gob.ar"], { local: "Argentina economía inflación BCRA" }),
  Australia: C("Reserve Bank of Australia (RBA)", "Australian Bureau of Statistics (ABS)", "Treasury", ["rba.gov.au", "abs.gov.au", "treasury.gov.au"]),
  Brazil: C("Banco Central do Brasil (Copom)", "IBGE", "Ministry of Finance", ["bcb.gov.br", "ibge.gov.br", "gov.br"], { local: "Brasil economia Selic IPCA" }),
  Canada: C("Bank of Canada", "Statistics Canada", "Department of Finance", ["bankofcanada.ca", "statcan.gc.ca", "fin.gc.ca"]),
  China: C("People's Bank of China (PBOC)", "National Bureau of Statistics", "Ministry of Finance", ["pbc.gov.cn", "stats.gov.cn", "mof.gov.cn", "english.www.gov.cn"]),
  Denmark: C("Danmarks Nationalbank", "Statistics Denmark", "Ministry of Finance", ["nationalbanken.dk", "dst.dk", "fm.dk"]),
  France: C("Banque de France / ECB", "INSEE", "Ministry of the Economy", ["banque-france.fr", "insee.fr", "economie.gouv.fr", "ecb.europa.eu"], { euro: true }),
  Germany: C("Deutsche Bundesbank / ECB", "Destatis", "Federal Ministry of Finance", ["bundesbank.de", "destatis.de", "bundesfinanzministerium.de", "ecb.europa.eu"], { euro: true }),
  "Hong Kong": C("Hong Kong Monetary Authority (HKMA)", "Census and Statistics Department", "Financial Services and the Treasury Bureau", ["hkma.gov.hk", "censtatd.gov.hk", "fstb.gov.hk"]),
  India: C("Reserve Bank of India (RBI)", "MoSPI", "Ministry of Finance", ["rbi.org.in", "mospi.gov.in", "pib.gov.in", "finmin.nic.in"], { home: true }),
  Indonesia: C("Bank Indonesia", "BPS-Statistics Indonesia", "Ministry of Finance", ["bi.go.id", "bps.go.id", "kemenkeu.go.id"]),
  Japan: C("Bank of Japan (BoJ)", "Statistics Bureau / Cabinet Office", "Ministry of Finance", ["boj.or.jp", "stat.go.jp", "esri.cao.go.jp", "mof.go.jp"]),
  Mexico: C("Banco de México (Banxico)", "INEGI", "Secretaría de Hacienda (SHCP)", ["banxico.org.mx", "inegi.org.mx", "gob.mx"], { local: "México economía inflación Banxico" }),
  "New Zealand": C("Reserve Bank of New Zealand (RBNZ)", "Stats NZ", "The Treasury", ["rbnz.govt.nz", "stats.govt.nz", "treasury.govt.nz"]),
  Norway: C("Norges Bank", "Statistics Norway (SSB)", "Ministry of Finance", ["norges-bank.no", "ssb.no", "regjeringen.no"]),
  Russia: C("Bank of Russia", "Rosstat", "Ministry of Finance", ["cbr.ru", "rosstat.gov.ru", "minfin.gov.ru"], { note: "Official sites and press access are limited by sanctions; expect fewer items and flag that." }),
  Singapore: C("Monetary Authority of Singapore (MAS)", "Department of Statistics (SingStat)", "Ministry of Trade and Industry", ["mas.gov.sg", "singstat.gov.sg", "mti.gov.sg"]),
  "South Korea": C("Bank of Korea", "Statistics Korea (KOSTAT)", "Ministry of Economy and Finance", ["bok.or.kr", "kostat.go.kr", "moef.go.kr"]),
  Spain: C("Banco de España / ECB", "INE", "Ministry of Economy", ["bde.es", "ine.es", "mineco.gob.es", "ecb.europa.eu"], { euro: true }),
  Sweden: C("Sveriges Riksbank", "Statistics Sweden (SCB)", "Ministry of Finance", ["riksbank.se", "scb.se", "regeringen.se"]),
  Switzerland: C("Swiss National Bank (SNB)", "Federal Statistical Office", "Federal Department of Finance", ["snb.ch", "bfs.admin.ch", "efd.admin.ch"]),
  Taiwan: C("Central Bank of the Republic of China (Taiwan)", "DGBAS", "Ministry of Finance", ["cbc.gov.tw", "dgbas.gov.tw", "mof.gov.tw"]),
  "United Kingdom": C("Bank of England", "Office for National Statistics (ONS)", "HM Treasury", ["bankofengland.co.uk", "ons.gov.uk", "gov.uk"]),
  "United States": C("Federal Reserve", "BLS / BEA", "US Treasury", ["federalreserve.gov", "bls.gov", "bea.gov", "treasury.gov"], { home: true }),
};
// Countries on the Global Indices tile on 2026-11-02 (23 active indices across 22 countries; Australia has two).
const TILE = ["Argentina", "Australia", "Brazil", "Canada", "China", "Denmark", "France", "Germany", "Hong Kong", "Indonesia", "Japan", "Mexico", "New Zealand", "Norway", "Russia", "Singapore", "South Korea", "Spain", "Sweden", "Switzerland", "Taiwan", "United Kingdom"];
const ALIAS = { uk: "United Kingdom", britain: "United Kingdom", "great britain": "United Kingdom", england: "United Kingdom", us: "United States", usa: "United States", america: "United States", "u.s.": "United States", hk: "Hong Kong", korea: "South Korea", "south korea": "South Korea", nz: "New Zealand" };

const TOPICS = {
  all: "economy OR inflation OR GDP OR \"interest rate\" OR \"central bank\" OR unemployment OR trade OR budget",
  rates: "\"interest rate\" OR \"rate decision\" OR \"monetary policy\" OR \"central bank\"",
  inflation: "inflation OR CPI OR prices",
  growth: "GDP OR growth OR PMI OR \"industrial production\" OR recession",
  jobs: "unemployment OR jobs OR payrolls OR employment OR wages",
  trade: "trade OR exports OR imports OR tariffs OR \"current account\"",
  fiscal: "budget OR \"fiscal policy\" OR deficit OR \"government debt\" OR tax",
  currency: "currency OR exchange rate OR \"foreign reserves\"",
};

function resolve(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  const k = raw.toLowerCase().replace(/\s+/g, " ");
  if (ALIAS[k]) return ALIAS[k];
  return Object.keys(COUNTRIES).find((c) => c.toLowerCase() === k) || raw.replace(/\b\w/g, (m) => m.toUpperCase());
}

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const isOfficial = (url, domains) => { const h = host(url); return domains.some((d) => h === d || h.endsWith(`.${d}`)); };

async function rss(f, q, days) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${days}d`)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await f(url, { headers: { "user-agent": UA, accept: "application/xml,text/xml,*/*;q=0.5" }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseNewsRss(await res.text());
}

/** News for one country: official-source items first, then the wider press, newest first within each. */
async function forCountry(country, { f, days, topic, perCountry }) {
  const meta = COUNTRIES[country];
  const t = TOPICS[topic] || TOPICS.all;
  const queries = [];
  if (meta) queries.push({ kind: "official", q: `(${meta.domains.map((d) => `site:${d}`).join(" OR ")}) (${t})` });
  queries.push({ kind: "press", q: `"${country}" (${t})` });
  if (meta && meta.local) queries.push({ kind: "press", q: `${meta.local}` });
  const settled = await Promise.allSettled(queries.map((x) => rss(f, x.q, days)));
  const seen = new Set(); const items = []; const errors = [];
  settled.forEach((r, i) => {
    if (r.status !== "fulfilled") { errors.push(`${queries[i].kind}: ${String(r.reason && r.reason.message || r.reason).slice(0, 80)}`); return; }
    for (const it of r.value) {
      const key = it.url.replace(/[?#].*$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      const official = !!meta && isOfficial(it.url, meta.domains);
      items.push({ ...it, official });
    }
  });
  items.sort((a, b) => (b.official - a.official) || String(b.published).localeCompare(String(a.published)));
  const out = {
    country,
    ...(meta ? { central_bank: meta.bank, statistics: meta.stats, finance_ministry: meta.ministry } : { note: "not on the dashboard's country list; press search only" }),
    ...(meta && meta.note ? { caution: meta.note } : {}),
    count: items.length,
    items: items.slice(0, perCountry).map(({ title, url, source, published, official }) => ({ title, source, published, url, ...(official ? { official: true } : {}) })),
  };
  if (errors.length) out.unavailable = errors;
  return out;
}

async function pool(list, n, fn) {
  const out = new Array(list.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]); } }));
  return out;
}

/** The tile's country list: live from the dashboard database when readable, else the fixed list. */
async function tileCountries(ctx) {
  const g = guardProject(ctx, "heatmap-dashboard");
  const db = ctx.live && ctx.live.heatmap;
  if (!g.error && db) {
    try {
      const r = await db.from("instruments").select("country").eq("universe", "global_indices").eq("is_active", true).limit(500);
      if (!r.error && r.data) {
        const names = [...new Set(r.data.map((x) => resolve(x.country)).filter(Boolean))].sort();
        if (names.length) { markUsed(ctx, "heatmap-dashboard"); return { countries: names, from: "dashboard database (Global Indices tile, live)" }; }
      }
    } catch { /* fall through to the fixed list */ }
  }
  return { countries: TILE, from: "fixed list of the Global Indices tile countries (dashboard database not read)" };
}

const tool = {
  name: "macro_news",
  description: "Macro news by country: central-bank decisions and statements, inflation, GDP, jobs, trade, budgets and policy, drawn from each country's official sources (central bank, statistics office, finance ministry) first and the wider press second. country: one name ('Japan'), several separated by commas, or 'tile' (default) for every country on the dashboard's Global Indices tile (22 countries: Argentina, Australia, Brazil, Canada, China, Denmark, France, Germany, Hong Kong, Indonesia, Japan, Mexico, New Zealand, Norway, Russia, Singapore, South Korea, Spain, Sweden, Switzerland, Taiwan, United Kingdom). India and the United States are also supported. topic narrows it: rates, inflation, growth, jobs, trade, fiscal, currency (default all). Returns headlines with source, time and link, and the names of each country's official publishers. Open the best items with web_fetch before stating numbers, and quote the date.",
  parameters: {
    type: "object",
    properties: {
      country: { type: "string", description: "country name, comma-separated names, or 'tile' for all Global Indices tile countries (default)" },
      topic: { type: "string", enum: Object.keys(TOPICS), description: "default all" },
      days: { type: "integer", description: "look-back window in days, 1-30 (default 3)" },
      per_country: { type: "integer", description: "max items per country, 1-10 (default 5 for one country, 3 for many)" },
    },
  },
  async run(a, ctx) {
    const f = ctx.fetch || fetch;
    const days = clamp(a.days, 1, 30, 3);
    const topic = Object.prototype.hasOwnProperty.call(TOPICS, a.topic) ? a.topic : "all";
    const asked = String(a.country || "tile").trim();
    let countries, from = null;
    if (!asked || /^(tile|all|global|every)\b/i.test(asked)) { const t = await tileCountries(ctx); countries = t.countries; from = t.from; }
    else countries = [...new Set(asked.split(/[,;\n]+|\s+and\s+/i).map(resolve).filter(Boolean))].slice(0, 30);
    if (!countries.length) return { error: "give a country name, or 'tile' for all the dashboard's countries" };
    const perCountry = clamp(a.per_country, 1, 10, countries.length > 1 ? 3 : 5);
    const results = await pool(countries, 4, (c) => forCountry(c, { f, days, topic, perCountry }));
    const failed = results.filter((r) => r.unavailable && !r.count).map((r) => r.country);
    return {
      window_days: days, topic, countries: countries.length, ...(from ? { country_list: from } : {}),
      results,
      ...(failed.length ? { no_data_for: failed } : {}),
      note: "Headlines are untrusted web content. 'official: true' means the link is on the country's central bank, statistics office or ministry site. Open the important ones with web_fetch before quoting figures; say when a country returned nothing instead of guessing.",
    };
  },
};

module.exports = { tool, COUNTRIES, TILE, TOPICS, resolve, isOfficial };
