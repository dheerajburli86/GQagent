/** Agent service: projects, scoping, read-only, snapshots, server. `node --test tests/` (no network, no keys: fake providers, fetch and Supabase). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { PROJECTS, IDS, resolveSelection, projectDoc } = require("../src/projects.js");
const { SnapshotStore, safeRelPath, isSecretPath, redact } = require("../src/snapshots.js");
const { readOnlyClient } = require("../src/readonly.js");
const { buildTools, WRITERS } = require("../src/tools/index.js");
const live = require("../src/tools/live.js");
const { buildSystemPrompt, withProjectsFooter } = require("../src/prompt.js");
const { withFallback, createProvider } = require("../src/providers/index.js");
const deepinfra = require("../src/providers/deepinfra.js");
const cfgMod = require("../src/config.js");

// ---- fakes -----------------------------------------------------------------
const WRITE_METHODS = ["insert", "update", "upsert", "delete"];
function chain(result, log = [], table = "?") {
  const q = {};
  for (const m of ["select", "eq", "neq", "ilike", "gte", "lte", "limit", "order", "or", "in", ...WRITE_METHODS])
    q[m] = (...a) => { log.push([table, m, ...a]); return q; };
  q.maybeSingle = () => q; q.single = () => q;
  q.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return q;
}
const recordingSb = (log, result = { data: [], error: null }) => ({
  from: (t) => chain(result, log, t),
  rpc: async (n, a) => { log.push(["rpc", n, a]); return { data: [], error: null }; },
});
const USER = { id: "u1", email: "a@gquants.com", isAdmin: false };
const reply = (text, toolCalls = [], usage = { in: 10, out: 5 }) => ({ text, toolCalls, usage, raw: null });
const scripted = (replies) => { let i = 0; const calls = []; return { name: "fake", model: "fake-1", calls, chat: async (a) => { calls.push(JSON.parse(JSON.stringify(a))); return replies[Math.min(i++, replies.length - 1)]; } }; };

function tmpRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-test-"));
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
  return dir;
}
const SAMPLE = {
  "README.md": "# Demo\nHello docs\n",
  "CLAUDE.md": "notes for agents\n",
  "src/app.js": "const A = 1;\nfunction fetchPrices() { return 42; }\n// TODO fetchPrices again\n",
  "docs/guide.md": "guide body",
  ".env": "SUPABASE_KEY=supersecretvalue123456",
  ".env.example": "SUPABASE_URL=https://x.supabase.co\n",
  "config/keys.js": "const k = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnop1234';\nAPI_TOKEN = 'abcdefghijklmnopqrstu'\n",
  "node_modules/x/index.js": "ignored",
  "img.bin": Buffer.from([1, 2, 0, 3]),
};
async function storeWith(ids = IDS) {
  const store = new SnapshotStore({ projects: PROJECTS, log: () => {} });
  const dir = tmpRepo(SAMPLE);
  for (const id of ids) await store.loadFromDir(id, dir, "deadbeefcafe0000");
  return store;
}
const tool = (tools, name) => tools.find((t) => t.name === name);

// ---- project selection -----------------------------------------------------
test("selection: 'all', arrays, dedupe, and rejects unknown/empty", () => {
  assert.deepEqual(resolveSelection("all"), IDS);
  assert.deepEqual(resolveSelection(["all"]), IDS);
  assert.deepEqual(resolveSelection(["busybee", "BusyBee", " gq-finxray-us "]), ["busybee", "gq-finxray-us"]);
  assert.throws(() => resolveSelection(["busybee", "secret-repo"]), (e) => e.status === 400 && /Unknown project/.test(e.message));
  assert.deepEqual(resolveSelection([]), [], "[] means general only");
  assert.throws(() => resolveSelection(undefined), (e) => e.status === 400);
  assert.throws(() => resolveSelection("busybee"), (e) => e.status === 400);
});

test("PROJECTS.md has a section for every project", () => {
  for (const id of IDS) assert.match(projectDoc(id), new RegExp(`\\(\`${id}\`\\)`), id);
});

// ---- scoping ----------------------------------------------------------------
test("scoping: every repo tool refuses a project that is not selected, and declares only selected ones", async () => {
  const store = await storeWith();
  const selected = ["busybee"];
  const tools = buildTools({ selected, user: USER });
  for (const name of ["list_files", "read_file", "grep_code", "read_docs"]) {
    const t = tool(tools, name);
    assert.deepEqual(t.parameters.properties.project.enum, ["busybee"], name);
    const ctx = { selected, store, projectsUsed: new Set() };
    const r = await t.run({ project: "heatmap-dashboard", path: "README.md", query: "Hello" }, ctx);
    assert.equal(r.not_selected, true, name);
    assert.match(r.error, /not selected/);
    assert.equal(ctx.projectsUsed.size, 0, `${name} must not mark a refused project as used`);
    const ok = await t.run({ project: "busybee", path: "README.md", query: "Hello" }, ctx);
    assert.ok(!ok.error, `${name}: ${ok.error}`);
    assert.deepEqual([...ctx.projectsUsed], ["busybee"]);
  }
});

test("scoping: unknown project id is refused", async () => {
  const store = await storeWith();
  const t = tool(buildTools({ selected: IDS, user: USER }), "read_file");
  const r = await t.run({ project: "../../etc", path: "README.md" }, { selected: IDS, store });
  assert.match(r.error, /unknown project/);
});

test("scoping: live DB tools exist only when heatmap-dashboard is selected, and re-check at call time", async () => {
  const without = buildTools({ selected: ["busybee", "gq-finxray-us"], user: USER, liveOn: true });
  assert.ok(!without.some((t) => t.kind === "live"));
  const withH = buildTools({ selected: ["heatmap-dashboard"], user: USER, liveOn: true });
  const find = tool(withH, "find_instrument");
  assert.equal(find.kind, "live");
  const log = [];
  const ctxBad = { selected: ["busybee"], live: live.buildLiveClients(recordingSb(log)), projectsUsed: new Set() };
  const r = await find.run({ query: "TCS" }, ctxBad);
  assert.equal(r.not_selected, true);
  assert.equal(log.length, 0, "no query may run for an unselected project");
});

test("footer: names exactly the projects whose tools ran; strips a model-written line", () => {
  assert.equal(withProjectsFooter("Answer.\nProjects used: everything", new Set(["busybee"]), ["heatmap-dashboard", "busybee"]), "Answer.\n\n📁 From: BusyBee");
  assert.equal(withProjectsFooter("Hi", new Set(), ["busybee"]), "Hi", "no project read: no footer at all");
  assert.equal(withProjectsFooter("x\nProjects used: none", new Set(["gq-finxray-us"]), ["busybee"]), "x", "only selected projects count");
});

// ---- path traversal & secrets -------------------------------------------------
test("read_file: traversal, absolute, URL, home, NUL and backslash paths are rejected", async () => {
  const store = await storeWith(["busybee"]);
  const t = tool(buildTools({ selected: ["busybee"], user: USER }), "read_file");
  const ctx = { selected: ["busybee"], store, projectsUsed: new Set() };
  for (const p of ["../heatmap-dashboard/CLAUDE.md", "src/../../x", "..\\..\\etc\\passwd", "file:///etc/passwd", "~/.ssh/id_rsa", "C:/Windows/win.ini", "a\0b", "", "..", "x/".repeat(300)]) {
    const r = await t.run({ project: "busybee", path: p }, ctx);
    assert.ok(r.error, `should reject ${JSON.stringify(p).slice(0, 40)}`);
    assert.ok(!r.content);
  }
  // an absolute path is read as repo-relative, never as a host path
  const abs = await t.run({ project: "busybee", path: "/etc/passwd" }, ctx);
  assert.match(abs.error, /no such file: etc\/passwd/);
  const ok = await t.run({ project: "busybee", path: "./src/app.js", start_line: 2, end_line: 2 }, ctx);
  assert.equal(ok.content, "function fetchPrices() { return 42; }");
  assert.equal(ok.commit, "deadbeefcafe");
});

test("snapshot: symlinks are not followed, secret files are dropped, credentials redacted, vendored dirs skipped", async () => {
  const dir = tmpRepo(SAMPLE);
  fs.symlinkSync("/etc/passwd", path.join(dir, "passwd-link"));
  fs.symlinkSync("/etc", path.join(dir, "etc-dir-link"));
  const store = new SnapshotStore({ projects: PROJECTS, log: () => {} });
  const s = await store.loadFromDir("busybee", dir, "x");
  const paths = [...s.files.keys()];
  assert.ok(!paths.some((p) => p.includes("passwd") || p.startsWith("etc-dir-link")));
  assert.ok(!paths.includes(".env"));
  assert.ok(paths.includes(".env.example"));
  assert.ok(!paths.some((p) => p.startsWith("node_modules/")));
  assert.equal(s.files.get("img.bin").text, null);
  const keys = s.files.get("config/keys.js").text;
  assert.ok(!keys.includes("eyJhbGci"), "JWT must be redacted");
  assert.ok(!keys.includes("abcdefghijklmnopqrstu"), "TOKEN= value must be redacted");
  assert.equal(isSecretPath("deploy/prod.pem"), true);
  assert.equal(isSecretPath("src/env.js"), false);
  assert.equal(redact("x AIza" + "a".repeat(35) + " y"), "x [REDACTED] y");
  const tg = "1234567890:" + "AAbC_d-E".repeat(4) + "xyz"; // 35 chars after the colon
  assert.equal(redact(`GET https://api.telegram.org/bot${tg}/sendMessage`), "GET https://api.telegram.org/bot[REDACTED]/sendMessage");
  assert.equal(redact(`token: ${tg}`), "token: [REDACTED]");
  assert.equal(isSecretPath("logs.1786683958208.log"), true);
  assert.equal(isSecretPath("app/server.log.1"), true);
  assert.equal(isSecretPath("docs/logging.md"), false);
  assert.equal(safeRelPath("a/./b//c"), "a/b/c");
});

test("grep_code is literal (regex metacharacters are not interpreted) and list_files globs", async () => {
  const store = await storeWith(["gdp-macro-dashboard"]);
  const tools = buildTools({ selected: ["gdp-macro-dashboard"], user: USER });
  const ctx = { selected: ["gdp-macro-dashboard"], store, projectsUsed: new Set() };
  const g = await tool(tools, "grep_code").run({ project: "gdp-macro-dashboard", query: "fetchPrices()" }, ctx);
  assert.equal(g.total_matches, 1);
  const evil = await tool(tools, "grep_code").run({ project: "gdp-macro-dashboard", query: "(a+)+$" }, ctx);
  assert.equal(evil.total_matches, 0);
  const l = await tool(tools, "list_files").run({ project: "gdp-macro-dashboard", pattern: "*.md" }, ctx);
  assert.deepEqual(l.files.map((f) => f.path).sort(), ["CLAUDE.md", "README.md", "docs/guide.md"]);
  const d = await tool(tools, "read_docs").run({ project: "gdp-macro-dashboard" }, ctx);
  assert.match(d.overview, /GDP/);
  assert.ok(d.docs.includes("CLAUDE.md"));
  const doc = await tool(tools, "read_docs").run({ project: "gdp-macro-dashboard", doc: "../../x" }, ctx);
  assert.match(doc.error, /invalid/);
});

// ---- read-only enforcement --------------------------------------------------
test("read-only: the read client has no write methods and refuses unlisted tables/RPCs", () => {
  const log = [];
  const ro = readOnlyClient(recordingSb(log), { tables: ["instruments"], rpcs: ["team_agent_screen"] });
  const qb = ro.from("instruments");
  for (const m of WRITE_METHODS) assert.equal(qb[m], undefined, m);
  assert.throws(() => ro.from("team_tasks"), /allowlist/);
  assert.throws(() => ro.from("users"), /allowlist/);
  assert.throws(() => ro.rpc("team_agent_add_usage", {}), /allowlist/);
  assert.equal(ro.storage, undefined); assert.equal(ro.auth, undefined);
  assert.ok(Object.isFrozen(ro) && Object.isFrozen(qb), "handles are frozen");
});

test("read-only: every live tool runs within the allowlist and never writes", async () => {
  const log = [];
  const ctx = { selected: ["heatmap-dashboard"], live: live.buildLiveClients(recordingSb(log)), projectsUsed: new Set() };
  const id = "11111111-2222-3333-4444-555555555555";
  const liveTools = buildTools({ selected: ["heatmap-dashboard"], user: USER, liveOn: true }).filter((t) => t.kind === "live");
  assert.ok(liveTools.length >= 8);
  for (const t of liveTools) {
    const r = await t.run({ query: "TCS", instrument_id: id, universe: "india_stocks", metric: "ret_1d", window: "1y" }, ctx);
    assert.ok(!(r && r.error && /allowlist/.test(r.error)), `${t.name}: ${r && r.error}`);
  }
  assert.ok(log.length > 0);
  assert.ok(!log.some((e) => WRITE_METHODS.includes(e[1])), "a live tool issued a write");
});

test("web_fetch: SSRF guard blocks internal targets, including via redirect, before any request is made", async () => {
  const web = tool(buildTools({ selected: ["busybee"], user: USER }), "web_fetch");
  const calls = [];
  const fakeFetch = async (u) => { calls.push(u); return new Response("", { status: 302, headers: { location: "http://10.0.0.5/admin" } }); };
  for (const u of ["http://169.254.169.254/latest/meta-data", "http://127.0.0.1:8080/", "http://localhost/", "http://[::1]/", "file:///etc/passwd", "http://10.1.2.3/", "http://192.168.0.1/", "http://metadata.internal/"]) {
    const ctx = { fetch: fakeFetch };
    await assert.rejects(() => web.run({ url: u }, ctx), /blocked|only http|not a valid/, u);
  }
  assert.equal(calls.length, 0, "no request may leave for a blocked URL");
  // a public literal IP that redirects to a private one: first hop allowed, second blocked
  await assert.rejects(() => web.run({ url: "http://8.8.8.8/" }, { fetch: fakeFetch }), /blocked/);
  assert.deepEqual(calls, ["http://8.8.8.8/"]);
});

// ---- providers ----------------------------------------------------------------
test("prompt: lists selected vs unselected projects, language and neutrality rules", () => {
  const s = buildSystemPrompt({ user: USER, selected: ["busybee"], toolNames: ["read_file"] });
  assert.match(s, /you may read ONLY these\):\n- busybee/);
  assert.match(s, /NOT selected[\s\S]*heatmap-dashboard[\s\S]*Do not guess/);
  assert.match(s, /Hinglish/);
  assert.match(s, /Never recommend buying, selling or holding/);
  assert.match(s, /only about investment advice/);
  assert.match(s, /read-only/);
  const all = buildSystemPrompt({ user: USER, selected: IDS });
  assert.ok(!/NOT selected/.test(all));
});

// ---- snapshot download (fake GitHub) --------------------------------------------
test("snapshot refresh: downloads the tarball for the branch head, skips when unchanged, explains a 404", async () => {
  const src = tmpRepo({ "README.md": "hi", "a/b.py": "print(1)" });
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "ma-tar-"));
  fs.cpSync(src, path.join(stage, "owner-repo-abc123"), { recursive: true });
  const tgz = path.join(os.tmpdir(), `ma-${Date.now()}.tgz`);
  execFileSync("tar", ["-czf", tgz, "-C", stage, "owner-repo-abc123"]);
  const tarBytes = fs.readFileSync(tgz);
  const seen = [];
  const fakeFetch = async (url, opts) => {
    seen.push([url, opts.headers.authorization || null]);
    if (url.includes("/commits/")) return new Response("abc123def4567890", { status: 200 });
    if (url.includes("/tarball/abc123def4567890")) return new Response(tarBytes, { status: 200 });
    return new Response("nope", { status: 404 });
  };
  const store = new SnapshotStore({ projects: PROJECTS, token: "ghs_test", fetchImpl: fakeFetch, log: () => {} });
  const [a, b] = await Promise.all([store.ensure("busybee"), store.ensure("busybee")]);
  assert.equal(a, b, "concurrent callers share one download");
  assert.equal(a.sha, "abc123def4567890");
  assert.deepEqual([...a.files.keys()].sort(), ["README.md", "a/b.py"]);
  assert.equal(seen.filter(([u]) => u.includes("tarball")).length, 1);
  assert.ok(seen.every(([, auth]) => auth === "Bearer ghs_test"));
  await store.refresh("busybee");
  assert.equal(seen.filter(([u]) => u.includes("tarball")).length, 1, "unchanged head: no second download");
  assert.match(seen[0][0], /repos\/dheerajburli86\/busybee\/commits\/main$/);

  const s404 = new SnapshotStore({ projects: PROJECTS, fetchImpl: async () => new Response("", { status: 404 }), log: () => {} });
  await assert.rejects(() => s404.ensure("heatmap-dashboard"), /GITHUB_READ_TOKEN/);
  assert.match(s404.status().find((x) => x.id === "heatmap-dashboard").error, /404/);
});

// ---- server: auth, budget, selection, end to end with a fake model ----------------
const CFG = { ...cfgMod.load({}), emailDomain: "gquants.com", dailyTokensPerUser: 1000, monthlyTokensGlobal: 100000, ratePerMin: 50, maxSteps: 5, requestDeadlineMs: 5000, corsOrigins: [] };
const U = (email = "a@gquants.com") => ({ id: "u-" + email, email, email_confirmed_at: "2026-01-01" });

async function withServer(opts, fn) {
  const calls = [];
  const members = { "a@gquants.com": { email: "a@gquants.com", active: true, is_admin: false }, "boss@gquants.com": { email: "boss@gquants.com", active: true, is_admin: true } };
  const sb = {
    auth: {
      getUser: async (t) => {
        if (t === "good") return { data: { user: U() }, error: null };
        if (t === "admin") return { data: { user: U("boss@gquants.com") }, error: null };
        if (t === "outsider") return { data: { user: U("x@gquants.com") }, error: null };
        if (t === "gmail") return { data: { user: U("x@gmail.com") }, error: null };
        return { data: { user: null }, error: new Error("bad") };
      },
    },
    rpc: async (n, a) => { calls.push(["rpc", n, a]); return { error: null }; },
    from: (t) => {
      if (t === "team_agent_members") {
        const q = chain(null, calls, t);
        q.eq = (k, v) => { calls.push([t, "eq", k, v]); q.then = (res) => Promise.resolve({ data: members[v] || null, error: null }).then(res); return q; };
        return q;
      }
      if (t === "team_agent_usage") return chain({ data: opts.usage || [], error: null }, calls, t);
      return chain({ data: null, error: null }, calls, t);
    },
  };
  const store = opts.store || (await storeWith());
  const provider = opts.provider === undefined ? scripted([reply("hello")]) : opts.provider;
  const server = createApp({ cfg: CFG, sb, provider, store });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, { provider, calls }); } finally { await new Promise((r) => server.close(r)); }
}
const post = (base, p, body, tok = "good") => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(tok ? { authorization: "Bearer " + tok } : {}) }, body: JSON.stringify(body) });

test("tool and snapshot code never write to repos, run git, or spawn a shell", () => {
  const dir = path.join(__dirname, "..", "src");
  const toolSrc = ["tools/repo.js", "tools/live.js", "tools/index.js", "tools/scope.js"].map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  assert.ok(!/child_process|writeFile|\bfs\b\.|require\("fs/.test(toolSrc), "tools must not touch fs or processes");
  const snap = fs.readFileSync(path.join(dir, "snapshots.js"), "utf8");
  assert.ok(!/execFile\(\s*["']git|"push"|\bexec\(|spawn\(/.test(snap), "snapshot code must not run git or a shell");
  assert.match(snap, /execFile\(cmd/); // only tar via execFile, with fixed args
});

// ---- standalone additions -----------------------------------------------------

test("general only ([]): no repo or live tools, prompt says no project is selected", () => {
  const tools = buildTools({ selected: [], user: USER });
  assert.deepEqual(tools.map((t) => t.kind).filter((k) => k === "repo" || k === "live"), []);
  assert.ok(["current_time", "web_search", "web_fetch", "calculate"].every((n) => tools.some((t) => t.name === n)));
  const s = buildSystemPrompt({ user: USER, selected: [], toolNames: tools.map((t) => t.name) });
  assert.match(s, /No project is selected/);
  assert.match(s, /web_search for quick lookups/);
  assert.match(s, /calculate for any non-trivial arithmetic/);
});

