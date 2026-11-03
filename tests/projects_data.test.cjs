/** Full project-database access, team identity via BusyBee, BusyBee task actions. `npm test` (no network). */
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { ProjectDb, buildProjectDbs, cleanRows } = require("../src/projectdb.js");
const { Team } = require("../src/team.js");
const database = require("../src/tools/database.js");
const busybee = require("../src/tools/busybee.js");
const { buildTools } = require("../src/tools/index.js");
const { buildSystemPrompt } = require("../src/prompt.js");
const { IDS } = require("../src/projects.js");

// ---- a tiny fake of supabase-js: records every call, returns canned rows per table
function fakeClient(tables, log = []) {
  return {
    from(table) {
      const calls = [["from", table]];
      const b = {};
      for (const m of ["select", "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in", "contains", "or", "order", "range", "limit"]) {
        b[m] = (...a) => { calls.push([m, ...a]); return b; };
      }
      for (const w of ["insert", "update", "upsert", "delete"]) b[w] = () => { throw new Error(`write attempted: ${w}`); };
      const result = () => {
        log.push(calls);
        let rows = (tables[table] || []).slice();
        for (const [m, col, v] of calls) {
          if (m === "eq") rows = rows.filter((r) => String(r[col]) === String(v));
          if (m === "in") rows = rows.filter((r) => v.map(String).includes(String(r[col])));
          if (m === "ilike" && table !== "users") { const t = String(v).replace(/%/g, "").toLowerCase(); rows = rows.filter((r) => String(r[col] || "").toLowerCase().includes(t)); }
          if (m === "or" && /\.ilike\./.test(col)) {
            const terms = col.split(",").map((x) => x.split(".ilike.")).filter((x) => x.length === 2);
            rows = rows.filter((r) => terms.some(([c, pat]) => String(r[c] || "").toLowerCase().includes(pat.replace(/%/g, "").toLowerCase())));
          }
        }
        const sel = calls.find((c) => c[0] === "select");
        const head = sel && sel[2] && sel[2].head;
        return { data: head ? null : rows, count: rows.length, error: null };
      };
      b.maybeSingle = async () => { const r = result(); return { data: (r.data || [])[0] || null, error: null }; };
      b.then = (res, rej) => Promise.resolve(result()).then(res, rej);
      return b;
    },
  };
}
const openapi = (defs) => async (url, o) => new Response(JSON.stringify({ definitions: defs }), { status: 200, headers: { "x-auth": o.headers.authorization || "" } });

const BB = {
  user_telegram: [{ user_id: "11111111-1111-1111-1111-111111111111", chat_id: "777" }],
  users: [
    { id: "11111111-1111-1111-1111-111111111111", full_name: "Dheeraj Burli", email: "dheeraj@gq.com", salary: 100 },
    { id: "22222222-2222-2222-2222-222222222222", full_name: "Asha Rao", email: "asha@gq.com", salary: 200 },
    { id: "33333333-3333-3333-3333-333333333333", full_name: "Asha Kumar", email: "akumar@gq.com", salary: 300 },
  ],
  desk_members: [
    { desk_id: "d1", user_id: "11111111-1111-1111-1111-111111111111", role: "admin" },
    { desk_id: "d1", user_id: "22222222-2222-2222-2222-222222222222", role: "member" },
    { desk_id: "d1", user_id: "33333333-3333-3333-3333-333333333333", role: "member" },
  ],
  projects: [{ id: "44444444-4444-4444-4444-444444444444", name: "Heatmap", desk_id: "d1" }],
  tasks: [{ id: "t1", title: "Fix tile", status: "pending" }],
  app_secrets: [{ name: "x", value: "y" }],
};
const bbDb = (log) => new ProjectDb({ project: "busybee", url: "https://bb.supabase.co", key: "sb_secret_x", client: fakeClient(BB, log),
  fetchImpl: openapi({ tasks: { properties: { id: {}, title: {}, status: {} } }, users: { properties: { id: {}, email: {}, password_hash: {}, salary: {} } }, app_secrets: { properties: {} }, telegram_link_tokens: { properties: {} } }) });

test("databases: one handle per project whose URL and key are set; nothing for the others", () => {
  const d = buildProjectDbs({ BUSYBEE_SUPABASE_URL: "https://a.supabase.co", BUSYBEE_SUPABASE_KEY: "k", FINXRAY_SUPABASE_URL: "https://b.supabase.co", FINXRAY_SUPABASE_KEY: "k2", GDP_SUPABASE_URL: "https://c" }, { makeClient: () => fakeClient({}) });
  assert.deepEqual(Object.keys(d).sort(), ["busybee", "gq-finxray-us"]);
});

test("databases: table list comes from PostgREST, with credential tables and columns removed; JWT keys get a bearer header, new keys don't", async () => {
  const t = await bbDb().tables();
  assert.deepEqual(Object.keys(t).sort(), ["tasks", "users"]);
  assert.deepEqual(Object.keys(t.users.columns), ["id", "email", "salary"]);
  let auth;
  const legacy = new ProjectDb({ project: "x", url: "https://x", key: "eyJabc", client: fakeClient({}), fetchImpl: async (u, o) => { auth = o.headers.authorization; return new Response("{}"); } });
  await legacy.tables(); assert.equal(auth, "Bearer eyJabc");
  const modern = new ProjectDb({ project: "x", url: "https://x", key: "sb_secret_1", client: fakeClient({}), fetchImpl: async (u, o) => { auth = o.headers.authorization; return new Response("{}"); } });
  await modern.tables(); assert.equal(auth, undefined);
});

test("rows: credential columns are dropped everywhere; pay and bank details only for BusyBee admins; long text is trimmed", () => {
  const rows = [{ name: "A", password: "p", api_key: "k", salary: 5, bank_account_number: "1", nested: { access_token: "t", ok: 1 }, long: "x".repeat(2500) }];
  const member = cleanRows(rows)[0];
  assert.deepEqual(Object.keys(member).sort(), ["bank_account_number", "long", "name", "nested", "salary"]);
  assert.equal(member.salary, "(hidden: admins only)");
  assert.deepEqual(member.nested, { ok: 1 });
  assert.match(member.long, /2500 characters/);
  assert.equal(cleanRows(rows, { canSeePay: true })[0].salary, 5);
});

test("team: a Telegram ID linked in BusyBee is a member with their name and highest role; anyone else is not", async () => {
  const team = new Team({ busybee: bbDb() });
  const m = await team.member(777);
  assert.equal(m.name, "Dheeraj Burli"); assert.equal(m.role, "admin"); assert.deepEqual(m.desks, [{ desk_id: "d1", role: "admin" }]);
  assert.equal(await team.member(999), null);
  assert.equal(await new Team({ busybee: null }).member(777), null);
});

const memberCtx = (over = {}) => ({ selected: IDS, projectDbs: { busybee: bbDb(over.log) }, projectsUsed: new Set(), member: { userId: "11111111-1111-1111-1111-111111111111", name: "Dheeraj Burli", role: "member", desks: [{ desk_id: "d1", role: "admin" }], telegramId: "777" }, ...over });
const q = (ctx, a) => database.makeTools(IDS, ctx.projectDbs).find((t) => t.name === "project_query").run({ project: "busybee", ...a }, ctx);

test("project_query: members read any table with filters, sorting, paging and counts; strangers are refused unless data is open to everyone", async () => {
  const log = [];
  const ctx = memberCtx({ log });
  const r = await q(ctx, { table: "users", where: [{ column: "email", op: "ilike", value: "%gq%" }], order: "full_name", limit: 2, offset: 1 });
  assert.equal(r.returned, 3, "the fake ignores ilike on users and range; the calls are what matter");
  assert.equal(r.rows[0].salary, "(hidden: admins only)");
  const calls = log.at(-1).map((c) => c[0]);
  assert.deepEqual(calls, ["from", "select", "ilike", "order", "range"]);
  assert.deepEqual(log.at(-1).find((c) => c[0] === "range").slice(1), [1, 2]);
  assert.ok(ctx.projectsUsed.has("busybee"));
  assert.equal((await q(ctx, { table: "users", count_only: true })).count, 3);
  assert.match((await q({ ...ctx, member: null }, { table: "users" })).error, /team only[\s\S]*link your Telegram in BusyBee/);
  assert.equal((await q({ ...ctx, member: null, openData: true }, { table: "users" })).returned, 3);
  assert.match((await q({ ...ctx, selected: [] }, { table: "users" })).error, /not selected/);
});

test("project_query: credential tables, odd names and credential selects are refused; BusyBee hides others' private to-dos and deleted tasks", async () => {
  const log = [];
  const ctx = memberCtx({ log });
  assert.match((await q(ctx, { table: "app_secrets" })).error, /credentials/);
  assert.match((await q(ctx, { table: "users; drop table x" })).error, /plain table name/);
  assert.match((await q(ctx, { table: "users", select: "id, password_hash" })).error, /credential/);
  assert.match((await q(ctx, { table: "users", where: [{ column: "id", op: "regex", value: 1 }] })).error, /op must be/);
  await q(ctx, { table: "tasks" });
  const calls = log.at(-1);
  assert.ok(calls.some((c) => c[0] === "or" && /personal\.is\.null,personal\.eq\.false,assigned_to\.eq\.1111/.test(c[1])));
  assert.ok(calls.some((c) => c[0] === "is" && c[1] === "deleted_at" && c[2] === null));
  const admin = await q({ ...ctx, member: { ...ctx.member, role: "admin" } }, { table: "users" });
  assert.equal(admin.rows[0].salary, 100, "BusyBee admins see pay");
});

test("busybee: names become ids on the asker's desks; ambiguous names ask; dates are IST", async () => {
  const db = bbDb();
  const m = memberCtx().member;
  assert.deepEqual(await busybee.findPerson(db, m, "me"), { id: m.userId, name: "Dheeraj Burli" });
  const amb = await busybee.findPerson(db, m, "asha");
  assert.match(amb.error, /more than one person/);
  assert.deepEqual(amb.candidates.map((c) => c.name).sort(), ["Asha Kumar", "Asha Rao"]);
  assert.equal((await busybee.findPerson(db, m, "Asha Rao")).id, "22222222-2222-2222-2222-222222222222");
  assert.match((await busybee.findPerson(db, m, "Zed")).error, /no one called/);
  assert.equal(busybee.istTime("2026-11-05T18:00"), "2026-11-05T12:30:00.000Z");
  assert.equal(busybee.istTime("2026-11-05"), "2026-11-05T12:30:00.000Z", "a date alone means 6 pm IST");
  assert.equal(busybee.istTime("not a date"), null);
});

test("busybee_create_task: posts to BusyBee's own API as the asker (secret + Telegram ID), and reports what was made", async () => {
  const sent = [];
  const fetchImpl = async (url, o) => { sent.push({ url, o, body: JSON.parse(o.body) }); return new Response(JSON.stringify({ task: { id: "t9", title: "Q3 deck", priority: "high", subtask_count: 0 } }), { status: 200 }); };
  const db = new ProjectDb({ project: "busybee", url: "https://bb", key: "k", client: fakeClient({ ...BB, users: BB.users.filter((u) => u.full_name !== "Asha Kumar") }), fetchImpl });
  const ctx = { ...memberCtx(), projectDbs: { busybee: db }, fetch: fetchImpl, busybeeApi: { url: "https://busybee.example.com", secret: "S".repeat(32) } };
  const create = busybee.tools.find((t) => t.name === "busybee_create_task");
  const r = await create.run({ title: "Q3 deck", due: "2026-11-07T17:00", assignee: "Asha", priority: "high", project: "Heatmap" }, ctx);
  assert.equal(r.created.id, "t9"); assert.equal(r.created.for, "Asha Rao"); assert.equal(r.created.project, "Heatmap");
  assert.equal(sent[0].url, "https://busybee.example.com/api/tasks");
  assert.equal(sent[0].o.method, "POST");
  assert.equal(sent[0].o.headers["x-agent-secret"], "S".repeat(32));
  assert.equal(sent[0].o.headers["x-agent-telegram-id"], "777");
  assert.deepEqual(sent[0].body, { title: "Q3 deck", due_date: "2026-11-07T11:30:00.000Z", assigned_to: "22222222-2222-2222-2222-222222222222", priority: "high", project_id: "44444444-4444-4444-4444-444444444444" });
  // BusyBee's own refusal comes back as is
  const deny = { ...ctx, fetch: async () => new Response(JSON.stringify({ error: "Members can't assign tasks to others. Ask an admin." }), { status: 403 }) };
  assert.match((await create.run({ title: "x", due: "2026-11-07", assignee: "Asha" }, deny)).error, /Members can't assign/);
  const bad = { ...ctx, fetch: async () => new Response("{}", { status: 401 }) };
  assert.match((await create.run({ title: "x", due: "2026-11-07", assignee: "me" }, bad)).error, /AGENT_SHARED_SECRET/);
  assert.match((await create.run({ title: "x", due: "2026-11-07", assignee: "me" }, { ...ctx, member: null })).error, /team members/);
  assert.match((await create.run({ title: "x", due: "2026-11-07", assignee: "me" }, { ...ctx, busybeeApi: null })).error, /BUSYBEE_APP_URL/);
});

test("busybee_update_task: needs a task id and something to change; sends only what changes", async () => {
  const sent = [];
  const ctx = { ...memberCtx(), busybeeApi: { url: "https://bb", secret: "S".repeat(32) }, fetch: async (u, o) => { sent.push(JSON.parse(o.body)); return new Response(JSON.stringify({ task: { title: "Fix tile", status: "done", progress_percent: 100 } })); } };
  const up = busybee.tools.find((t) => t.name === "busybee_update_task");
  assert.match((await up.run({ task_id: "nope" }, ctx)).error, /task's id/);
  assert.match((await up.run({ task_id: "55555555-5555-5555-5555-555555555555" }, ctx)).error, /what to change/);
  const r = await up.run({ task_id: "55555555-5555-5555-5555-555555555555", status: "done", progress_percent: 140 }, ctx);
  assert.equal(r.updated.status, "done");
  assert.deepEqual(sent[0], { id: "55555555-5555-5555-5555-555555555555", status: "done", progress_percent: 100 });
});

test("registry: data tools for configured projects; BusyBee actions only in live chats with BusyBee selected; the prompt names the member", () => {
  const dbs = { busybee: bbDb() };
  const names = (o) => buildTools({ selected: IDS, projectDbs: dbs, ...o }).map((t) => t.name);
  assert.ok(names({}).includes("project_query"));
  assert.ok(!names({}).includes("busybee_create_task"), "scheduled runs: no actions");
  assert.ok(names({ taskTools: true, busybeeActions: true }).includes("busybee_create_task"));
  assert.ok(!buildTools({ selected: ["heatmap-dashboard"], projectDbs: dbs, taskTools: true, busybeeActions: true }).some((t) => t.name.startsWith("busybee_") || t.name.startsWith("project_")));
  const sys = buildSystemPrompt({ user: {}, member: { name: "Dheeraj Burli", userId: "u1", role: "admin" }, selected: IDS, toolNames: ["project_query", "busybee_create_task"] });
  assert.match(sys, /GQuants team member: Dheeraj Burli, BusyBee user id u1, BusyBee role admin/);
  assert.match(sys, /busybee_create_task and busybee_update_task act in BusyBee as this person/);
  assert.match(buildSystemPrompt({ user: {}, selected: IDS, toolNames: ["project_query"] }), /NOT a linked team member/);
});
