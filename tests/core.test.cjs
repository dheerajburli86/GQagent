/** Core pieces (agent loop, providers, web, dashboard, budgets): `npm test` */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { runAgent, sanitizeHistory, MAX_MESSAGE_CHARS } = require("../src/agent.js");
const { RateLimiter, istDay } = require("../src/state.js");
const deepinfra = require("../src/providers/deepinfra.js");
const web = require("../src/tools/web.js");
const dash = require("../src/tools/dashboard.js");
const cfgMod = require("../src/config.js");

// ---- fakes -----------------------------------------------------------------
function chain(result, log = []) {
  const q = {};
  for (const m of ["select", "eq", "neq", "ilike", "gte", "limit", "order", "insert", "update", "or", "in"])
    q[m] = (...a) => { log.push([m, ...a]); return q; };
  q.maybeSingle = () => q; q.single = () => q;
  q.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return q;
}
const CFG = { ...cfgMod.load({}), emailDomain: "gquants.com", dailyTokensPerUser: 1000, monthlyTokensGlobal: 100000, ratePerMin: 3, maxSteps: 4, requestDeadlineMs: 5000, corsOrigins: ["https://dash.example"] };
const USER = { id: "u1", email: "a@gquants.com", isAdmin: false };
const scripted = (replies) => { let i = 0; const calls = []; return { name: "fake", model: "fake-1", calls, chat: async (a) => { calls.push(a); return replies[Math.min(i++, replies.length - 1)]; } }; };
const reply = (text, toolCalls = [], usage = { in: 10, out: 5 }) => ({ text, toolCalls, usage, raw: null });
const echoTool = { name: "echo", description: "e", parameters: { type: "object", properties: {} }, run: async (a) => ({ got: a }) };

// ---- agent loop ------------------------------------------------------------
test("loop: tool call, result fed back, final answer, usage summed", async () => {
  const p = scripted([reply("", [{ id: "1", name: "echo", args: { x: 1 } }]), reply("done")]);
  const audits = [];
  const out = await runAgent({ provider: p, tools: [echoTool], system: "s", message: "hi", ctx: { audit: async (r) => audits.push(r) } });
  assert.equal(out.answer, "done");
  assert.deepEqual(out.steps.map((s) => [s.tool, s.ok]), [["echo", true]]);
  assert.deepEqual(out.usage, { in: 20, out: 10 });
  const toolMsg = p.calls[1].messages.find((m) => m.role === "tool");
  assert.equal(JSON.parse(toolMsg.content).got.x, 1);
  assert.equal(audits[0].tool, "echo");
});

test("loop: unknown tool and throwing tool become errors the model can see, not crashes", async () => {
  const boom = { ...echoTool, name: "boom", run: async () => { throw new Error("db down"); } };
  const p = scripted([reply("", [{ id: "1", name: "nope", args: {} }, { id: "2", name: "boom", args: {} }]), reply("ok")]);
  const out = await runAgent({ provider: p, tools: [boom], system: "s", message: "hi", ctx: {} });
  assert.equal(out.answer, "ok");
  assert.deepEqual(out.steps.map((s) => s.ok), [false, false]);
  const msgs = p.calls[1].messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content).error);
  assert.match(msgs[0], /unknown tool/); assert.match(msgs[1], /db down/);
});

test("loop: stops at maxSteps and the last call offers no tools", async () => {
  const p = scripted([reply("", [{ id: "1", name: "echo", args: {} }])]);
  const out = await runAgent({ provider: p, tools: [echoTool], system: "s", message: "hi", ctx: {}, maxSteps: 3 });
  assert.equal(p.calls.length, 3);
  assert.equal(p.calls[2].tools.length, 0);
  assert.match(out.answer, /ran out of steps/);
});

test("loop: budget is checked before every model call and aborts the turn", async () => {
  const p = scripted([reply("", [{ id: "1", name: "echo", args: {} }]), reply("x")]);
  let n = 0;
  await assert.rejects(runAgent({ provider: p, tools: [echoTool], system: "s", message: "hi", ctx: {}, checkBudget: async () => { if (++n === 2) throw new Error("budget"); } }), /budget/);
  assert.equal(p.calls.length, 1);
});

test("loop: oversized tool results are truncated", async () => {
  const big = { ...echoTool, name: "big", run: async () => ({ s: "x".repeat(50000) }) };
  const p = scripted([reply("", [{ id: "1", name: "big", args: {} }]), reply("ok")]);
  await runAgent({ provider: p, tools: [big], system: "s", message: "hi", ctx: {} });
  assert.ok(p.calls[1].messages.find((m) => m.role === "tool").content.length < 12100);
});

test("history: only user/assistant strings, last 20, capped length", () => {
  const h = [{ role: "system", content: "evil" }, { role: "user", content: 5 }, ...Array.from({ length: 30 }, (_, i) => ({ role: "user", content: "m" + i }))];
  const s = sanitizeHistory(h);
  assert.equal(s.length, 20);
  assert.ok(s.every((m) => m.role === "user" && typeof m.content === "string"));
  assert.equal(sanitizeHistory([{ role: "user", content: "y".repeat(50000) }])[0].content.length, MAX_MESSAGE_CHARS);
  assert.deepEqual(sanitizeHistory("nope"), []);
});

// ---- registry --------------------------------------------------------------
function authSb({ user, member, userErr }) {
  return { auth: { getUser: async () => ({ data: { user }, error: userErr || null }) }, from: () => chain({ data: member, error: null }) };
}
const reqWith = (tok) => ({ headers: tok ? { authorization: "Bearer " + tok } : {} });
const U = (o = {}) => ({ id: "u1", email: "A@GQuants.com", email_confirmed_at: "2026-01-01", ...o });

test("deepinfra: OpenAI message mapping and tool-call parsing", async () => {
  const msgs = deepinfra.toMessages("sys", [{ role: "user", content: "q" }, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "echo", args: { a: 1 } }] }, { role: "tool", toolCallId: "c1", name: "echo", content: "{}" }]);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[2].tool_calls[0].function.arguments, '{"a":1}');
  assert.equal(msgs[3].tool_call_id, "c1");
  const d = deepinfra.create({ apiKey: "K", model: "m", fetchImpl: async (u, init) => { assert.equal(init.headers.authorization, "Bearer K"); return { ok: true, json: async () => ({ choices: [{ message: { content: "", tool_calls: [{ id: "x", function: { name: "echo", arguments: "{not json" } }] } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }) }; } });
  const r = await d.chat({ system: "s", messages: [{ role: "user", content: "q" }], tools: [echoTool] });
  assert.deepEqual(r.toolCalls[0].args, {});
  assert.deepEqual(r.usage, { in: 3, out: 4 });
});

// ---- web tools -------------------------------------------------------------
test("web: private and internal addresses are blocked", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])
    assert.equal(web.isPrivateIp(ip), true, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(web.isPrivateIp(ip), false, ip);
  const pub = async () => [{ address: "93.184.216.34" }];
  await assert.rejects(web.assertPublicUrl("file:///etc/passwd", pub), /http/);
  await assert.rejects(web.assertPublicUrl("http://localhost/x", pub), /internal/);
  await assert.rejects(web.assertPublicUrl("http://169.254.169.254/latest/meta-data", pub), /internal/);
  await assert.rejects(web.assertPublicUrl("http://evil.test/", async () => [{ address: "10.0.0.5" }]), /internal/);
  await assert.doesNotReject(web.assertPublicUrl("https://example.com/", pub));
});

test("web_fetch: redirect to an internal address is refused", async () => {
  const lookup = async (h) => [{ address: h === "internal.test" ? "10.0.0.9" : "93.184.216.34" }];
  const fetchImpl = async () => ({ status: 302, ok: false, headers: new Map([["location", "http://internal.test/admin"]]) });
  await assert.rejects(web.fetchPublic("https://example.com/", { fetchImpl, lookup }), /internal/);
});

test("htmlToText drops scripts, keeps text and title", () => {
  const r = web.htmlToText("<html><head><title>T &amp; Co</title><script>evil()</script></head><body><h1>Hi</h1><p>a&nbsp;b</p><style>x{}</style></body></html>");
  assert.equal(r.title, "T & Co");
  assert.ok(r.text.includes("Hi") && r.text.includes("a b"));
  assert.ok(!r.text.includes("evil") && !r.text.includes("x{}"));
});

// ---- dashboard + task tools -------------------------------------------------
const tool = (list, name) => list.find((t) => t.name === name);

test("find_instrument: strips filter-breaking characters and merges symbol + name hits", async () => {
  const log = [];
  const sb = { from: () => chain({ data: [{ id: "i1", symbol: "TCS", name: "Tata Consultancy", universe: "india_stocks" }], error: null }, log) };
  const r = await tool(dash.tools, "find_instrument").run({ query: "tcs),or=(1=1" }, { sb });
  const patterns = log.filter((c) => c[0] === "ilike").map((c) => c[2]);
  assert.ok(patterns.every((p) => !/[(),=]/.test(p)), patterns.join("|"));
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].instrument_id, "i1");
});

test("tools reject a non-UUID instrument_id before touching the database", async () => {
  const sb = { from: () => { throw new Error("must not be called"); } };
  for (const n of ["get_instrument", "technical_signals", "price_history", "india_volume", "fundamentals"])
    assert.match((await tool(dash.tools, n).run({ instrument_id: "x'; drop table instruments;--" }, { sb })).error, /UUID/);
});

test("screen: forwards bounded RPC params and rejects unknown universes", async () => {
  let args;
  const sb = { rpc: async (n, a) => { args = [n, a]; return { data: [{ instrument_id: "i", symbol: "A", name: "A", val: 12.3456, price_native: 10, as_of: "2026-10-30" }], error: null }; } };
  const r = await tool(dash.tools, "screen").run({ universe: "us_stocks", order_by: "ret_1d", limit: 9999, min_market_cap_usd: "1e9" }, { sb });
  assert.equal(args[0], "team_agent_screen");
  assert.equal(args[1].p_limit, 50);
  assert.equal(args[1].p_min_cap, 1e9);
  assert.equal(args[1].p_desc, true);
  assert.equal(r.rows[0].value, 12.346);
  assert.match((await tool(dash.tools, "screen").run({ universe: "pg_catalog", order_by: "ret_1d" }, { sb })).error, /universe/);
});

