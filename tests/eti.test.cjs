/** ETI tools and the assigned-task worker. `npm test` (no network). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EtiClient, makeTools } = require("../src/tools/eti.js");
const { EtiTaskWorker, brief } = require("../src/etitasks.js");
const { buildTools } = require("../src/tools/index.js");
const { IDS } = require("../src/projects.js");

function fakeFetch(routes, calls = []) {
  return async (url, init) => {
    const u = new URL(url); const key = `${init.method} ${u.pathname}`;
    calls.push({ key, headers: init.headers, body: init.body ? JSON.parse(init.body) : null, search: u.search });
    const r = routes[key];
    if (!r) return { ok: false, status: 404, text: async () => JSON.stringify({ detail: "not found" }) };
    return { ok: true, status: 200, text: async () => JSON.stringify(typeof r === "function" ? r(init) : r) };
  };
}
const mk = (routes, calls) => new EtiClient({ url: "https://eti.test", key: "k", fetchImpl: fakeFetch(routes, calls) });
const tool = (eti, name) => makeTools(["eti"], eti).find((t) => t.name === name);

test("eti is a project", () => assert.ok(IDS.includes("eti")));

test("eti tools exist only when ETI is selected and connected", () => {
  const eti = mk({});
  assert.deepEqual(makeTools([], eti), []);
  assert.deepEqual(makeTools(["eti"], new EtiClient({ url: "", key: "" })), []);
  assert.deepEqual(buildTools({ selected: ["eti"], eti }).filter((t) => t.kind === "eti").map((t) => t.name).sort(), ["eti_api", "eti_schema", "eti_sql"]);
  assert.equal(buildTools({ selected: ["busybee"], eti }).some((t) => t.kind === "eti"), false);
});

test("eti_sql is gated to team members, works for them and for assigned tasks, and sends the key", async () => {
  const calls = [];
  const eti = mk({ "POST /agent/query": { rows: [{ n: 3 }], count: 1 } }, calls);
  const t = tool(eti, "eti_sql");
  const denied = await t.run({ sql: "select 1" }, { selected: ["eti"], eti });
  assert.equal(denied.not_a_member, true);
  const ok = await t.run({ sql: "select count(*) n from companies" }, { selected: ["eti"], eti, member: { userId: "u" } });
  assert.equal(ok.rows[0].n, 3);
  assert.equal(calls[0].headers["x-api-key"], "k");
  const task = await t.run({ sql: "select 1" }, { selected: ["eti"], eti, etiTask: true });
  assert.equal(task.count, 1);
  const unsel = await t.run({ sql: "select 1" }, { selected: ["busybee"], eti, etiTask: true });
  assert.equal(unsel.not_selected, true);
});

test("eti_api: GET reads; POST only when writes are allowed; the task-runner routes are closed", async () => {
  const calls = [];
  const eti = mk({ "GET /companies/5": { id: 5 }, "POST /links/submit": { batch_id: 9 } }, calls);
  const t = tool(eti, "eti_api");
  const base = { selected: ["eti"], eti, member: { userId: "u" } };
  assert.equal((await t.run({ method: "GET", path: "/companies/5" }, base)).id, 5);
  assert.match((await t.run({ method: "POST", path: "/links/submit", body: { text: "x" } }, base)).error, /not allowed/);
  assert.equal((await t.run({ method: "POST", path: "/links/submit", body: { text: "x" } }, { ...base, etiWrite: true })).batch_id, 9);
  assert.match((await t.run({ method: "POST", path: "/agent/tasks/claim" }, { ...base, etiWrite: true })).error, /task runner/);
  assert.match((await t.run({ method: "DELETE", path: "/companies/5" }, { ...base, etiWrite: true })).error, /GET and POST/);
  assert.equal((await t.run({ method: "GET", path: "/nope" }, base)).status, 404);
});

test("the worker claims a task, runs the agent with ETI access, and reports back", async () => {
  const calls = [];
  const eti = mk({
    "POST /agent/tasks/claim": { task: { id: 7, title: "Check Gland", instruction: "How many documents does Gland have?", assigned_by: "api_key", company_id: 1 }, company: { id: 1, name: "Gland Pharma", nse_symbol: "GLAND" } },
    "POST /agent/query": { rows: [{ n: 4 }], count: 1 },
    "POST /agent/tasks/7/report": { ok: true },
  }, calls);
  let step = 0;
  const provider = { name: "fake", model: "fake", async chat({ tools }) {
    if (step++ === 0) { assert.ok(tools.some((t) => t.name === "eti_sql")); return { text: "", toolCalls: [{ id: "1", name: "eti_sql", args: { sql: "select count(*) n from documents" } }], usage: { in: 1, out: 1 } }; }
    return { text: "Gland has 4 documents.", toolCalls: [], usage: { in: 1, out: 1 } };
  } };
  const notes = [];
  const w = new EtiTaskWorker({ cfg: { maxSteps: 12, etiTaskMaxSteps: 10, etiTaskDeadlineMs: 20000 }, eti, engines: { grok: provider }, snapshots: null, live: {}, log: () => {}, notify: async (t) => notes.push(t) });
  const res = await w.tick();
  assert.equal(res.status, "done");
  const report = calls.find((c) => c.key === "POST /agent/tasks/7/report");
  assert.equal(report.body.status, "done");
  assert.match(report.body.result, /4 documents/);
  assert.match(notes[0], /task #7 done/);
  assert.match(brief({ id: 7, title: "t", instruction: "do it" }, null), /ASSIGNED TASK #7/);
});

test("the worker does nothing when no task is waiting, and reports failure when the agent fails", async () => {
  const calls = [];
  const eti = mk({ "POST /agent/tasks/claim": { task: null } }, calls);
  const w = new EtiTaskWorker({ cfg: {}, eti, engines: { grok: {} }, log: () => {} });
  assert.equal(await w.tick(), null);
  const eti2 = mk({ "POST /agent/tasks/claim": { task: { id: 8, title: "x", instruction: "do something long" } }, "POST /agent/tasks/8/report": { ok: true } }, calls);
  const bad = { name: "f", model: "f", async chat() { throw new Error("model down"); } };
  const w2 = new EtiTaskWorker({ cfg: {}, eti: eti2, engines: { grok: bad }, log: () => {} });
  assert.equal((await w2.tick()).status, "failed");
  assert.equal(calls.find((c) => c.key === "POST /agent/tasks/8/report").body.status, "failed");
});
