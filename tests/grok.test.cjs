/** Grok (xAI) as a model option, and the web_research tool. `npm test` (no network). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const cfgMod = require("../src/config.js");
const { createProvider, GROK_URL } = require("../src/providers/index.js");
const research = require("../src/tools/research.js");
const { buildTools } = require("../src/tools/index.js");
const { buildSystemPrompt } = require("../src/prompt.js");

const ok = (j) => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
const reply = (text = "ok") => ({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } });

test("config: Grok is optional; DeepInfra stays the default main model", () => {
  const c = cfgMod.load({});
  assert.equal(c.agentProvider, "deepinfra");
  assert.equal(c.xaiKey, "");
  assert.equal(c.grokResearchModel, "grok-4.3");
  assert.equal(cfgMod.load({ AGENT_GROK_MODEL: "grok-x", XAI_API_KEY: "k" }).grokResearchModel, "grok-x", "research model follows the Grok model unless set");
});

test("providers: default is DeepInfra; AGENT_PROVIDER=grok uses xAI's chat endpoint; a missing key falls back to the other", async () => {
  let url, auth;
  const f = async (u, o) => { url = u; auth = o.headers.authorization; return ok(reply("hi")); };
  const dInfra = createProvider(cfgMod.load({ DEEPINFRA_API_KEY: "d" }), f);
  assert.equal(dInfra.name, "deepinfra");
  await dInfra.chat({ system: "s", messages: [{ role: "user", content: "q" }], tools: [] });
  assert.match(url, /api\.deepinfra\.com/); assert.equal(auth, "Bearer d");

  const grok = createProvider(cfgMod.load({ DEEPINFRA_API_KEY: "d", XAI_API_KEY: "x", AGENT_PROVIDER: "grok", AGENT_GROK_MODEL: "grok-4.3" }), f);
  assert.equal(grok.name, "grok>deepinfra");
  assert.equal(grok.model, "grok-4.3");
  await grok.chat({ system: "s", messages: [{ role: "user", content: "q" }], tools: [] });
  assert.equal(url, GROK_URL); assert.equal(auth, "Bearer x");

  const onlyGrok = createProvider(cfgMod.load({ XAI_API_KEY: "x", AGENT_PROVIDER: "deepinfra" }), f);
  assert.equal(onlyGrok.name, "grok", "no DeepInfra key: Grok is used even if DeepInfra was asked for");
  assert.equal(createProvider(cfgMod.load({}), f), null, "no keys at all: no provider");
});

test("web_research: declared only with a Grok key; calls the Responses API with web search; returns the answer and links", async () => {
  const off = buildTools({ selected: [], user: {}, researchTool: null });
  assert.ok(!off.some((t) => t.name === "web_research"));
  const tool = research.makeTool({ apiKey: "XAI", model: "grok-4.3", fetchImpl: async () => { throw new Error("unused"); } });
  const on = buildTools({ selected: [], user: {}, researchTool: tool });
  assert.ok(on.some((t) => t.name === "web_research"));

  let body, url, auth;
  const f = async (u, o) => {
    url = u; auth = o.headers.authorization; body = JSON.parse(o.body);
    return ok({ output: [{ type: "web_search_call", id: "s1" }, { type: "message", content: [{ type: "output_text", text: "The repo rate is 5.50%.", annotations: [
      { type: "url_citation", url: "https://rbi.org.in/x", title: "RBI" }, { type: "url_citation", url: "https://rbi.org.in/x", title: "RBI again" }] }] }],
      usage: { input_tokens: 40, output_tokens: 12 } });
  };
  const live = research.makeTool({ apiKey: "XAI", model: "grok-4.3", fetchImpl: f });
  const ctx = { fetch: f, usage: { in: 0, out: 0 } };
  const r = await live.run({ question: "What is the RBI repo rate?" }, ctx);
  assert.equal(url, research.RESPONSES_URL);
  assert.equal(auth, "Bearer XAI");
  assert.deepEqual(body.tools, [{ type: "web_search" }]);
  assert.equal(body.model, "grok-4.3");
  assert.equal(r.answer, "The repo rate is 5.50%.");
  assert.deepEqual(r.sources, [{ title: "RBI", url: "https://rbi.org.in/x" }], "duplicate links are merged");
  assert.deepEqual(ctx.usage, { in: 40, out: 12 }, "research tokens count against the budget");
});

test("web_research: failures are readable and never echo the response body; empty answers suggest another tool", async () => {
  const unauth = research.makeTool({ apiKey: "k", model: "m", fetchImpl: async () => new Response("secret echo k", { status: 401 }) });
  const r = await unauth.run({ question: "x" }, {});
  assert.match(r.error, /check XAI_API_KEY/);
  assert.ok(!JSON.stringify(r).includes("secret echo"));
  const empty = research.makeTool({ apiKey: "k", model: "m", fetchImpl: async () => ok({ output: [] }) });
  assert.match((await empty.run({ question: "x" }, {})).error, /web_search/);
  assert.match((await unauth.run({ question: "" }, {})).error, /required/);
});

test("prompt: the research tool is described only when it is available", () => {
  assert.match(buildSystemPrompt({ user: {}, selected: [], toolNames: ["web_research"] }), /web_research for research questions/);
  assert.ok(!/web_research for research/.test(buildSystemPrompt({ user: {}, selected: [], toolNames: [] })));
});

test("hybrid: DeepInfra runs the conversation, calls web_research (Grok), and the answer carries the sources", async () => {
  const { answer } = require("../src/answer.js");
  const { SnapshotStore } = require("../src/snapshots.js");
  const { PROJECTS } = require("../src/projects.js");
  const seen = [];
  const provider = { name: "deepinfra", model: "google/gemini-2.5-flash", chat: async (a) => {
    seen.push(a);
    if (seen.length === 1) return { text: "", toolCalls: [{ id: "r1", name: "web_research", args: { question: "latest RBI repo rate" } }], usage: { in: 10, out: 5 } };
    return { text: "The repo rate is 5.50% per RBI's latest statement.", toolCalls: [], usage: { in: 20, out: 8 } };
  } };
  const xai = async (u, o) => {
    assert.equal(u, research.RESPONSES_URL);
    return ok({ output: [{ type: "message", content: [{ type: "output_text", text: "Repo rate 5.50%.", annotations: [{ type: "url_citation", url: "https://rbi.org.in/press", title: "RBI" }] }] }], usage: { input_tokens: 30, output_tokens: 6 } });
  };
  const tool = research.makeTool({ apiKey: "XAI", model: "grok-4.3", fetchImpl: xai });
  const cfg = cfgMod.load({});
  const r = await answer({ provider, cfg, snapshots: new SnapshotStore({ projects: PROJECTS, log: () => {} }), question: "What is the RBI repo rate now?", projects: [], researchTool: tool, fetchImpl: xai });
  assert.deepEqual(r.steps.map((s) => [s.tool, s.ok]), [["web_research", true]]);
  assert.match(r.answer, /5\.50%/);
  assert.ok(seen[0].tools.some((t) => t.name === "web_research"), "the model was offered the research tool");
  assert.equal(r.usage.in, 60, "model input 10 + 20, research input 30: all counted");
  assert.equal(r.usage.out, 19);
});
