/** DeepInfra provider, keyless web search, calculator. `npm test` (no network, no keys). */
const { test } = require("node:test");
const assert = require("node:assert/strict");

const deepinfra = require("../src/providers/deepinfra.js");
const { withFallback, createProvider } = require("../src/providers/index.js");
const search = require("../src/tools/search.js");
const calc = require("../src/tools/calc.js");
const { buildTools } = require("../src/tools/index.js");
const { IDS } = require("../src/projects.js");
const cfgMod = require("../src/config.js");

const USER = { id: "u1", email: "a@gquants.com", isAdmin: false };
const ok = (j) => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });

// ---- config / provider ---------------------------------------------------------
test("config: DeepInfra is the only provider; default model is google/gemini-2.5-flash", () => {
  const c = cfgMod.load({});
  assert.equal(c.model, "google/gemini-2.5-flash");
  assert.equal(c.fallbackModel, "");
  assert.equal(createProvider(c), null, "no key -> no provider (service still boots)");
  const c2 = cfgMod.load({ DEEPINFRA_API_KEY: "k", AGENT_MODEL: "x/y", AGENT_FALLBACK_MODEL: "x/z", AGENT_DAILY_TOKENS_PER_USER: "5" });
  assert.equal(c2.dailyTokensPerUser, 5);
  const p = createProvider(c2);
  assert.equal(p.model, "x/y");
  assert.match(p.name, />/);
  assert.equal(createProvider({ ...c2, fallbackModel: "" }).name, "deepinfra");
});

test("deepinfra: request shape (model, tools, tool_choice, max_tokens, bearer key) and every real tool schema is valid", async () => {
  let body, headers;
  const d = deepinfra.create({ apiKey: "KEY", model: "google/gemini-2.5-flash", maxTokens: 4096, fetchImpl: async (u, o) => { body = JSON.parse(o.body); headers = o.headers; assert.equal(u, "https://api.deepinfra.com/v1/openai/chat/completions"); return ok({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }); } });
  const attached = [{ name: "a.pdf", kind: "pdf", text: "x", pages: ["x"] }, { name: "b.csv", kind: "csv", text: "a\n1" }];
  const tools = buildTools({ selected: IDS, user: { ...USER, isAdmin: true }, attached, liveOn: true });
  assert.equal(tools.length, 25); // no task or watchlist writing tools outside a live chat
  await d.chat({ system: "s", messages: [{ role: "user", content: "q" }], tools });
  assert.equal(headers.authorization, "Bearer KEY");
  assert.equal(body.model, "google/gemini-2.5-flash");
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.tool_choice, "auto");
  const names = body.tools.map((t) => t.function.name);
  assert.equal(new Set(names).size, names.length, "unique tool names");
  for (const t of body.tools) {
    assert.match(t.function.name, /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/);
    const p = t.function.parameters;
    assert.equal(p.type, "object", t.function.name);
    assert.ok(p.properties && Object.keys(p.properties).length > 0, `${t.function.name}: Gemini rejects an OBJECT schema with no properties`);
    for (const r of p.required || []) assert.ok(p.properties[r], `${t.function.name}: required ${r} is declared`);
    assert.ok(!JSON.stringify(p).includes('"default"'), "only portable schema keys");
  }
});

test("deepinfra: tool messages carry name + id; string and object arguments both parse; empty answer is explained", async () => {
  const msgs = deepinfra.toMessages("sys", [{ role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", args: { a: 1 } }] }, { role: "tool", toolCallId: "c1", name: "read_file", content: "{}" }]);
  assert.deepEqual(msgs[2], { role: "tool", tool_call_id: "c1", name: "read_file", content: "{}" });
  const replies = [
    { choices: [{ message: { content: null, tool_calls: [{ id: "a", function: { name: "x", arguments: { q: 1 } } }, { function: { name: "y", arguments: '{"z":2}' } }] } }] },
    { choices: [{ message: { content: "" }, finish_reason: "length" }] },
    { choices: [{ message: { content: "" }, finish_reason: "content_filter" }] },
  ];
  let i = 0;
  const d = deepinfra.create({ apiKey: "k", model: "m", fetchImpl: async () => ok(replies[i++]) });
  const r1 = await d.chat({ system: "s", messages: [] });
  assert.deepEqual(r1.toolCalls.map((c) => c.args), [{ q: 1 }, { z: 2 }]);
  assert.ok(r1.toolCalls[1].id, "missing id is generated");
  assert.match((await d.chat({ system: "s", messages: [] })).text, /cut off/);
  assert.match((await d.chat({ system: "s", messages: [] })).text, /content_filter/);
});

test("deepinfra: 429/5xx/network errors retry 3 times; 400 does not retry", async () => {
  let n = 0;
  const flaky = deepinfra.create({ apiKey: "k", model: "m", retryDelayMs: 1, fetchImpl: async () => { n++; if (n === 1) throw new Error("ECONNRESET"); if (n === 2) return new Response("busy", { status: 429 }); return ok({ choices: [{ message: { content: "ok" } }] }); } });
  assert.equal((await flaky.chat({ system: "s", messages: [] })).text, "ok");
  assert.equal(n, 3);
  let m = 0;
  const bad = deepinfra.create({ apiKey: "k", model: "m", retryDelayMs: 1, fetchImpl: async () => { m++; return new Response("bad schema", { status: 400 }); } });
  await assert.rejects(() => bad.chat({ system: "s", messages: [] }), (e) => e.status === 400 && /bad schema/.test(e.message));
  assert.equal(m, 1);
});

test("fallback model: used on outage (5xx), NOT on a request error (4xx)", async () => {
  const logs = [];
  const err = (status) => { const e = new Error("x"); e.status = status; return e; };
  const good = { name: "deepinfra", model: "backup", chat: async () => ({ text: "from backup", toolCalls: [], usage: {} }) };
  const down = { name: "deepinfra", model: "main", chat: async () => { throw err(503); } };
  const p = withFallback(down, good, (m) => logs.push(m));
  const r = await p.chat({});
  assert.equal(r.text, "from backup"); assert.equal(p.lastModel, "backup"); assert.match(logs[0], /falling back to backup/);
  const rejecting = withFallback({ ...down, chat: async () => { throw err(400); } }, good, () => {});
  await assert.rejects(() => rejecting.chat({}), (e) => e.status === 400);
});

// ---- web search ------------------------------------------------------------------
const DDG = `<html><div class="result results_links results_links_deep result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>
<div class="result results_links results_links_deep web-result "><div class="links_main"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rbi.org.in%2Fpolicy%3Fa%3D1%26b%3D2&amp;rut=abc">RBI <b>Monetary</b> Policy &amp; Statement</a></h2>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">The repo rate was kept at <b>5.50%</b>.</a></div></div>
<div class="result results_links web-result"><a class="result__a" href="https://example.com/direct">Direct link</a><a class="result__snippet">Snippet two</a></div></html>`;
const RSS = `<?xml version="1.0"?><rss><channel><item><title>RBI holds rates - Mint</title><link>https://news.google.com/rss/articles/abc?oc=5</link><pubDate>Fri, 31 Oct 2026 09:15:00 GMT</pubDate><source url="https://livemint.com">Mint</source></item><item><title><![CDATA[Sensex & Nifty end higher]]></title><link>https://news.google.com/rss/articles/def</link><pubDate>Sat, 01 Nov 2026 03:00:00 GMT</pubDate><source url="x">ET</source></item></channel></rss>`;
const WIKI = { query: { search: [{ title: "Compound annual growth rate", snippet: 'The <span class="searchmatch">CAGR</span> is the mean annual growth rate' }] } };

test("search parsers: DuckDuckGo (ads dropped, redirect unwrapped, entities decoded), Google News RSS, Wikipedia", () => {
  const d = search.parseDuckDuckGo(DDG);
  assert.deepEqual(d, [
    { title: "RBI Monetary Policy & Statement", url: "https://www.rbi.org.in/policy?a=1&b=2", snippet: "The repo rate was kept at 5.50%." },
    { title: "Direct link", url: "https://example.com/direct", snippet: "Snippet two" },
  ]);
  const n = search.parseNewsRss(RSS);
  assert.equal(n.length, 2);
  assert.deepEqual(n[0], { title: "RBI holds rates - Mint", url: "https://news.google.com/rss/articles/abc?oc=5", source: "Mint", published: "2026-10-31 09:15 UTC" });
  assert.equal(n[1].title, "Sensex & Nifty end higher");
  const w = search.parseWikipedia(WIKI, "en");
  assert.deepEqual(w, [{ title: "Compound annual growth rate", url: "https://en.wikipedia.org/wiki/Compound_annual_growth_rate", snippet: "The CAGR is the mean annual growth rate" }]);
});

test("web_search: queries all three sources in parallel, tolerates failures, uses fixed hosts only", async () => {
  const t = buildTools({ selected: [], user: USER }).find((x) => x.name === "web_search");
  const seen = [];
  const f = async (url) => {
    seen.push(new URL(url).host);
    if (url.includes("duckduckgo")) return new Response(DDG, { status: 200 });
    if (url.includes("news.google")) return new Response(RSS, { status: 200 });
    return new Response("down", { status: 503 });
  };
  const r = await t.run({ query: "RBI policy" }, { fetch: f });
  assert.deepEqual(seen.sort(), ["en.wikipedia.org", "html.duckduckgo.com", "news.google.com"]);
  assert.equal(r.web.length, 2); assert.equal(r.news.length, 2);
  assert.match(r.unavailable.encyclopedia, /503/);
  assert.ok(!r.error);
  // a query cannot steer the host
  seen.length = 0;
  await t.run({ query: "x@evil.com/../ http://169.254.169.254", kind: "web" }, { fetch: f });
  assert.deepEqual(seen, ["html.duckduckgo.com"]);
  // Hindi query -> Hindi news/wikipedia
  const urls = [];
  await t.run({ query: "रिज़र्व बैंक", kind: "auto" }, { fetch: async (u) => { urls.push(u); return new Response("<rss></rss>", { status: 200 }); } });
  assert.ok(urls.some((u) => u.includes("hl=hi")) && urls.some((u) => u.startsWith("https://hi.wikipedia.org")));
  // everything down -> clear error
  const all = await t.run({ query: "x" }, { fetch: async () => { throw new Error("offline"); } });
  assert.equal(all.error, "every search source failed");
  // DDG bot wall is reported, not parsed as zero results
  const wall = await t.run({ query: "x", kind: "web" }, { fetch: async () => new Response('<div class="anomaly-modal">', { status: 200 }) });
  assert.match(wall.unavailable.web, /rate limited/);
});

// ---- calculator ------------------------------------------------------------------
const run = (expression) => calc.tool.run({ expression });

test("calculate: arithmetic, variables across lines, statistics, units", async () => {
  const r = await run("x = 1250000 * 0.18\nx / 12\nmean([4, 8, 15, 16, 23, 42])\nstd([2,4,4,4,5,5,7,9], 'uncorrected')\n5 km to mile\n0.1 + 0.2");
  assert.deepEqual(r.results.map((x) => x.result), ["225000", "18750", "18", "2", "3.1068559611867 mile", "0.3"]);
  assert.equal(r.last, "0.3");
});

test("calculate: finance functions match known values", async () => {
  const r = await run([
    "cagr(100, 250, 5)",                       // 2.5^(1/5) - 1 = 20.11%
    "npv(0.1, [-1000, 300, 400, 500])",        // -21.04
    "irr([-1000, 300, 400, 500])",             // ~8.9%
    "pmt(0.09/12, 240, 5000000)",              // home loan EMI: -44,986.30
    "fv(0.12/12, 60, -10000, 0)",              // SIP: 816,696.70
    "pv(0.08, 10, -1000)",                     // 6710.08
    "effectiveRate(0.12, 12)",                 // 12.6825%
  ].join("\n"));
  const v = r.results.map((x) => Number(x.result));
  const near = (a, b, tol) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);
  near(v[0], 0.2011244, 1e-6); near(v[1], -21.0368, 1e-3); near(v[2], 0.0889633, 1e-6);
  near(v[3], -44986.30, 0.01); near(v[4], 816696.70, 0.01); near(v[5], 6710.08, 0.01); near(v[6], 0.1268250, 1e-6);
});

test("calculate: errors are per line; code-loading functions are disabled; no env access", async () => {
  const r = await run("1/0\nfoo(3)\n2+2");
  assert.equal(r.results[0].result, "Infinity");
  assert.match(r.results[1].error, /Undefined function foo/);
  assert.equal(r.results[2].result, "4");
  for (const e of ["import({x: 1})", "evaluate('1+1')", "parse('1')", "createUnit('foo')", "simplify('x+x')"]) {
    const x = await run(e);
    assert.ok(x.results[0].error, `${e} must fail`);
  }
  const env = await run("process.env");
  assert.ok(env.results[0].error);
  assert.match((await run("irr([100, 200])")).results[0].error, /positive and one negative/);
  assert.deepEqual(await run("   "), { error: "expression is required" });
});

test("calculate: memory bombs and long work are stopped without hurting the server", async () => {
  const big = await run("zeros(20000, 20000)");
  assert.ok(big.error || big.results[0].error, JSON.stringify(big).slice(0, 200));
  const slow = await calc.evaluateIsolated(["sum(range(1, 300000000))"], { timeoutMs: 1500 });
  assert.ok(slow.error || slow.results[0].error);
  // the main process is fine afterwards
  assert.equal((await run("6*7")).last, "42");
});
