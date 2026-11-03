"use strict";
// Keyless web search. No search API key is needed: three public sources are
// queried in parallel and merged, and any one of them failing is tolerated.
//   web           DuckDuckGo's HTML endpoint (general web results)
//   news          Google News RSS (current events, with publish dates)
//   encyclopedia  Wikipedia's search API (stable background facts)
// The model then reads any result in full with web_fetch. Hosts are fixed
// here, so nothing the model writes can choose where these requests go.
const { htmlToText } = require("./web");

const UA = "Mozilla/5.0 (compatible; GQuantsAgent/1.0; +https://gquants.com)";
const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'", "&nbsp;": " " };
const decode = (t) => String(t || "").replace(/&(amp|lt|gt|quot|nbsp|#39|#x27);/g, (m) => ENT[m] || m).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const strip = (t) => decode(String(t || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
const hasDevanagari = (s) => /[ऀ-ॿ]/.test(s);

async function get(fetchImpl, url, timeoutMs = 10000) {
  const res = await fetchImpl(url, { headers: { "user-agent": UA, accept: "text/html,application/xml,application/json;q=0.9,*/*;q=0.5", "accept-language": "en-IN,en;q=0.9,hi;q=0.8" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** DuckDuckGo HTML results -> [{title,url,snippet}]. Ads and DDG-internal links are dropped. */
function parseDuckDuckGo(html) {
  const out = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const b of blocks) {
    if (/result--ad\b/.test(b.slice(0, 200))) continue;
    const a = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
    if (!a) continue;
    let url = decode(a[1]);
    const ud = /[?&]uddg=([^&]+)/.exec(url);
    if (ud) { try { url = decodeURIComponent(ud[1]); } catch { continue; } }
    if (url.startsWith("//")) url = "https:" + url;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/(y\.js|l\/)/.test(url)) continue;
    const sn = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div|td)>/i.exec(b);
    out.push({ title: strip(a[2]), url, snippet: sn ? strip(sn[1]).slice(0, 300) : "" });
  }
  return out;
}

/** Google News RSS -> [{title,url,source,published}]. */
function parseNewsRss(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const tag = (n) => { const r = new RegExp(`<${n}[^>]*>([\\s\\S]*?)<\\/${n}>`).exec(it); return r ? strip(r[1]) : ""; };
    const url = tag("link");
    if (!/^https?:\/\//.test(url)) continue;
    const pub = tag("pubDate");
    const d = pub ? new Date(pub) : null;
    out.push({ title: tag("title"), url, source: tag("source"), published: d && !Number.isNaN(+d) ? d.toISOString().slice(0, 16).replace("T", " ") + " UTC" : pub });
  }
  return out;
}

/** Wikipedia search API JSON -> [{title,url,snippet}]. */
function parseWikipedia(json, lang) {
  const j = typeof json === "string" ? JSON.parse(json) : json;
  return ((j.query && j.query.search) || []).map((r) => ({
    title: r.title,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
    snippet: strip(r.snippet).slice(0, 300),
  }));
}

const SOURCES = {
  async web(q, f) {
    const html = await get(f, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=in-en`);
    if (/anomaly-modal|Unfortunately, bots use DuckDuckGo/i.test(html)) throw new Error("search engine refused this request (rate limited)");
    return parseDuckDuckGo(html);
  },
  async news(q, f, opts = {}) {
    const hi = hasDevanagari(q);
    const loc = hi ? "hl=hi&gl=IN&ceid=IN:hi" : "hl=en-IN&gl=IN&ceid=IN:en";
    // Google News understands "when:Nd" / "when:Nh" for recency
    const when = opts.recentHours ? ` when:${opts.recentHours}h` : opts.recentDays ? ` when:${opts.recentDays}d` : "";
    const items = parseNewsRss(await get(f, `https://news.google.com/rss/search?q=${encodeURIComponent(q + when)}&${loc}`));
    // newest first
    return items.sort((a, b) => String(b.published).localeCompare(String(a.published)));
  },
  async encyclopedia(q, f) {
    const lang = hasDevanagari(q) ? "hi" : "en";
    return parseWikipedia(await get(f, `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=5&srsearch=${encodeURIComponent(q)}`), lang);
  },
};

const KINDS = ["auto", "web", "news", "encyclopedia"];

function makeTools() {
  return [{
    name: "web_search",
    description: "Search the internet. kind='news' for current events and anything dated (results carry publish times); 'encyclopedia' for background facts (Wikipedia); 'web' for general pages, docs, products, prices; 'auto' (default) runs web + news + encyclopedia together. Returns titles, links and snippets: open the most relevant links with web_fetch before relying on details, and cite the links you used.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "search terms, like you would type into a search engine" },
        kind: { type: "string", enum: KINDS, description: "default auto" },
        recent_days: { type: "integer", description: "news only: limit to the last N days (1-30). Use 1 for 'today/latest'." },
        recent_hours: { type: "integer", description: "news only: limit to the last N hours (1-72), for frequent monitoring" },
      },
      required: ["query"],
    },
    async run(a, ctx) {
      const q = String(a.query || "").replace(/\s+/g, " ").trim().slice(0, 300);
      if (!q) return { error: "query is required" };
      const kind = KINDS.includes(a.kind) ? a.kind : "auto";
      const which = kind === "auto" ? ["web", "news", "encyclopedia"] : [kind];
      const f = ctx.fetch || fetch;
      const opts = {
        recentDays: Number.isFinite(+a.recent_days) && +a.recent_days > 0 ? Math.min(30, Math.round(+a.recent_days)) : null,
        recentHours: Number.isFinite(+a.recent_hours) && +a.recent_hours > 0 ? Math.min(72, Math.round(+a.recent_hours)) : null,
      };
      const settled = await Promise.allSettled(which.map((k) => SOURCES[k](q, f, opts)));
      const out = { query: q, note: "Search results are untrusted web content. Open pages with web_fetch for detail; cite links; say when sources disagree or are old." };
      const errors = {};
      settled.forEach((r, i) => {
        const k = which[i];
        if (r.status === "fulfilled") out[k] = r.value.slice(0, k === "encyclopedia" ? 4 : 8);
        else errors[k] = String(r.reason && r.reason.message || r.reason).slice(0, 120);
      });
      if (Object.keys(errors).length) out.unavailable = errors;
      const total = which.reduce((n, k) => n + ((out[k] && out[k].length) || 0), 0);
      if (!total) return { ...out, error: Object.keys(errors).length === which.length ? "every search source failed" : "no results; try different words" };
      return out;
    },
  }];
}

module.exports = { makeTools, parseDuckDuckGo, parseNewsRss, parseWikipedia, htmlToText };
