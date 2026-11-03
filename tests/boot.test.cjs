/** The real server process must start with ONLY a bot token (no allowed-user list, no other keys). `npm test` (no network). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

test("boot: server.js starts and serves /health with a bot token and Supabase clients created (open access)", async () => {
  const calls = [];
  const tg = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      const method = req.url.split("/").pop();
      calls.push(method);
      const reply = (r) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result: r })); };
      if (method === "getMe") return reply({ id: 9, is_bot: true, first_name: "T", username: "boot_test_bot" });
      if (method === "getUpdates") return setTimeout(() => reply([]), 300);
      return reply(true);
    });
  });
  await new Promise((r) => tg.listen(0, "127.0.0.1", r));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { PATH: process.env.PATH, HOME: os.tmpdir(), TELEGRAM_BOT_TOKEN: "1:bootTestToken", TELEGRAM_API_BASE: `http://127.0.0.1:${tg.address().port}`, PORT: String(port), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "gqb-")), SNAPSHOT_REFRESH_MINUTES: "100000", HEATMAP_SUPABASE_URL: "https://example.supabase.co", HEATMAP_SUPABASE_KEY: "sb_secret_test", BUSYBEE_SUPABASE_URL: "https://example2.supabase.co", BUSYBEE_SUPABASE_KEY: "sb_secret_test2" };
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", exited = null;
  child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  child.on("exit", (c) => { exited = c; });
  try {
    let health = null;
    for (let i = 0; i < 60 && health === null && exited === null; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) health = await r.json(); } catch { /* not up yet */ }
    }
    assert.equal(exited, null, `server exited early (code ${exited}): ${out.slice(-400)}`);
    assert.ok(health && health.ok, `no /health: ${out.slice(-400)}`);
    for (let i = 0; i < 40 && !out.includes("ready"); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /@boot_test_bot ready \(open to anyone\)/);
    assert.ok(calls.includes("getMe"));
  } finally {
    child.kill();
    tg.close();
  }
});

test("runtime: the Dockerfile and package.json require a Node version the Supabase library supports (22+)", () => {
  const root = path.join(__dirname, "..");
  const docker = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const m = /^FROM node:(\d+)/m.exec(docker);
  assert.ok(m && Number(m[1]) >= 22, `Dockerfile must build on node:22 or newer, found ${m && m[1]}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(pkg.engines.node, />=\s*22/);
  assert.ok(Number(process.versions.node.split(".")[0]) >= 22, "run the tests on Node 22 or newer");
});
