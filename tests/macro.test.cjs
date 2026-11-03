/** macro_news: the Global Indices tile countries, official-source queries, flags, scope. `npm test` (no network). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const macro = require("../src/tools/macro.js");
const { buildTools } = require("../src/tools/index.js");

const rssItem = (title, url, source, date) => `<item><title>${title}</title><link>${url}</link><pubDate>${date}</pubDate><source>${source}</source></item>`;
const rss = (...items) => new Response(`<?xml version="1.0"?><rss><channel>${items.join("")}</channel></rss>`, { status: 200 });
const urls = [];
const fakeFetch = async (u) => {
  urls.push(decodeURIComponent(u));
  const q = decodeURIComponent(u);
  if (/site:boj\.or\.jp/.test(q)) return rss(rssItem("BoJ keeps policy rate unchanged", "https://www.boj.or.jp/en/mopo/mpmdeci/index.htm", "Bank of Japan", "Fri, 30 Oct 2026 05:00:00 GMT"));
  if (/"Japan"/.test(q)) return rss(rssItem("Japan core CPI rises 2.9%", "https://news.example.com/japan-cpi", "Example News", "Fri, 30 Oct 2026 08:00:00 GMT"), rssItem("BoJ keeps policy rate unchanged", "https://www.boj.or.jp/en/mopo/mpmdeci/index.htm?x=1", "Bank of Japan", "Fri, 30 Oct 2026 05:00:00 GMT"));
  if (/"Russia"/.test(q)) return new Response("no", { status: 503 });
  return rss();
};

test("macro: the tile list is the 22 country names on the dashboard (Australia has two indices, counted once), plus India and the US are supported", () => {
  assert.equal(macro.TILE.length, 22);
  for (const c of ["Argentina", "Australia", "Brazil", "Canada", "China", "Denmark", "France", "Germany", "Hong Kong", "Indonesia", "Japan", "Mexico", "New Zealand", "Norway", "Russia", "Singapore", "South Korea", "Spain", "Sweden", "Switzerland", "Taiwan", "United Kingdom"]) assert.ok(macro.COUNTRIES[c], c);
  assert.ok(macro.COUNTRIES.India && macro.COUNTRIES["United States"]);
  for (const c of macro.TILE) assert.ok(macro.COUNTRIES[c].domains.length >= 3, `${c} has official domains`);
  assert.equal(macro.resolve("uk"), "United Kingdom"); assert.equal(macro.resolve("hk"), "Hong Kong"); assert.equal(macro.resolve("south korea"), "South Korea");
});

test("macro: one country gets an official-sites query and a press query; official items come first and duplicates collapse", async () => {
  urls.length = 0;
  const r = await macro.tool.run({ country: "Japan", days: 2 }, { fetch: fakeFetch });
  assert.equal(r.countries, 1);
  const j = r.results[0];
  assert.equal(j.central_bank, "Bank of Japan (BoJ)");
  assert.equal(j.items.length, 2, "the BoJ item appears once even though two queries returned it");
  assert.equal(j.items[0].official, true);
  assert.match(j.items[0].url, /boj\.or\.jp/);
  assert.equal(j.items[1].official, undefined);
  assert.ok(urls.some((u) => /site:boj\.or\.jp OR site:stat\.go\.jp/.test(u)), "official-domain query");
  assert.ok(urls.every((u) => /when:2d/.test(u)), "window applied");
  assert.ok(urls.every((u) => u.startsWith("https://news.google.com/rss/search")), "fixed host");
});

test("macro: 'tile' (default) covers all 22 countries, a failing one is reported instead of hiding the rest", async () => {
  const r = await macro.tool.run({}, { fetch: fakeFetch });
  assert.equal(r.countries, 22);
  assert.match(r.country_list, /fixed list/);
  assert.deepEqual(r.no_data_for, ["Russia"]);
  assert.equal(r.results.find((x) => x.country === "Japan").items.length, 2);
  assert.match(r.results.find((x) => x.country === "Russia").caution, /sanctions/);
});

test("macro: topics narrow the query; unknown countries still get a press search; input is cleaned", async () => {
  urls.length = 0;
  await macro.tool.run({ country: "uk, Atlantis", topic: "inflation", days: 99 }, { fetch: fakeFetch });
  assert.ok(urls.some((u) => /"United Kingdom" \(inflation OR CPI OR prices\) when:30d/.test(u)), "alias resolved, topic and clamped window used");
  const a = urls.filter((u) => u.includes("Atlantis"));
  assert.equal(a.length, 1, "no official query for an unknown country");
  const r = await macro.tool.run({ country: "Atlantis" }, { fetch: fakeFetch });
  assert.match(r.results[0].note, /not on the dashboard/);
  assert.match((await macro.tool.run({ country: ",," }, { fetch: fakeFetch })).error || "tile", /give a country|tile/);
});

test("macro: reads the country list live from the dashboard only when that project is selected; otherwise the fixed list", async () => {
  const rows = ["Japan", "Brazil", "Australia", "Australia", "Vietnam"].map((country) => ({ country }));
  const db = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: rows }) }) }) }) }) };
  let used = new Set();
  const on = await macro.tool.run({ country: "tile" }, { fetch: fakeFetch, live: { heatmap: db }, selected: ["heatmap-dashboard"], projectsUsed: used });
  assert.deepEqual(on.results.map((x) => x.country), ["Australia", "Brazil", "Japan", "Vietnam"]);
  assert.match(on.country_list, /live/);
  assert.ok(used.has("heatmap-dashboard"));
  used = new Set();
  const off = await macro.tool.run({ country: "tile" }, { fetch: fakeFetch, live: { heatmap: db }, selected: [], projectsUsed: used });
  assert.equal(off.countries, 22); assert.equal(used.size, 0);
  const broken = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ error: { message: "x" } }) }) }) }) }) };
  assert.equal((await macro.tool.run({}, { fetch: fakeFetch, live: { heatmap: broken }, selected: ["heatmap-dashboard"], projectsUsed: new Set() })).countries, 22);
});

test("macro: offered everywhere (chat and scheduled runs), with the prompt rules to use it", () => {
  assert.ok(buildTools({ selected: [] }).some((t) => t.name === "macro_news"));
  const { buildRunPrompt } = require("../src/tasks.js");
  assert.match(buildRunPrompt({ id: 1, title: "t", schedule: "daily at 09:00 IST", mode: "digest", instruction: "macro news", seen: [] }), /use macro_news/);
  assert.match(require("../src/prompt.js").buildSystemPrompt({ user: {}, selected: [], toolNames: ["macro_news"] }), /macro_news for macro and economy news/);
});
