"use strict";
// Read-only snapshots of each project's repo, held IN MEMORY as a path -> text
// index. The tarball is unpacked into a temp dir only long enough to index it,
// then deleted, so the tools never touch the filesystem: read_file is a map
// lookup and a crafted path cannot reach anything outside the snapshot.
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "__pycache__", ".venv", "venv", ".cache", "coverage", ".vercel", ".turbo"]);

/** Files the agent never sees, even if someone committed them. */
function isSecretPath(p) {
  const base = p.split("/").pop().toLowerCase();
  if (/^\.env(\..+)?$/.test(base) && !/\.(example|sample|template)$/.test(base)) return true;
  if (/\.(pem|key|p12|pfx|keystore|jks)$/.test(base)) return true;
  if (/^(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/.test(base)) return true;
  if (/(^|[-_.])(secrets?|credentials?)\.(json|ya?ml|toml|env)$/.test(base)) return true;
  if (base === "service-account.json" || base === ".npmrc" || base === ".pypirc" || base === ".netrc") return true;
  if (/\.log(\.\d+)?$/.test(base) || /^logs?\.\d+.*\.log$/.test(base)) return true; // runtime logs: noise, and they capture tokens and PII
  return false;
}

/** Masks values that look like credentials inside otherwise readable files. */
const SECRET_PATTERNS = [
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs (Supabase keys)
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,
  /(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, // Telegram bot tokens, including inside ".../bot<token>/sendMessage" URLs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const SECRET_ASSIGN = /^(\s*[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\s*[=:]\s*)(["']?)([^\s"'#]{12,})\2/gm;
function redact(text) {
  let t = text;
  for (const re of SECRET_PATTERNS) t = t.replace(re, "[REDACTED]");
  return t.replace(SECRET_ASSIGN, (_, k, q) => `${k}${q}[REDACTED]${q}`);
}

/** Normalises a model-supplied path; returns null for anything that tries to leave the snapshot. */
function safeRelPath(p) {
  if (typeof p !== "string") return null;
  let s = p.trim().replace(/\\/g, "/");
  if (!s || s.includes("\0") || s.length > 400) return null;
  if (/^[a-z]+:/i.test(s) || s.startsWith("~")) return null; // URLs, drive letters, home dirs
  s = s.replace(/^\.\/+/, "").replace(/^\/+/, "");
  const parts = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    parts.push(seg);
  }
  return parts.join("/");
}

async function walk(root, maxFileBytes, maxTotalBytes) {
  const files = new Map();
  let total = 0, skipped = 0;
  async function rec(dir, rel) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) { skipped++; continue; } // never follow links out of the tree
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await rec(abs, relPath); continue; }
      if (!e.isFile() || isSecretPath(relPath)) { skipped++; continue; }
      const st = await fsp.lstat(abs);
      if (st.size > maxFileBytes || total + st.size > maxTotalBytes) { files.set(relPath, { size: st.size, text: null, reason: "too large" }); continue; }
      const buf = await fsp.readFile(abs);
      if (buf.subarray(0, 8000).includes(0)) { files.set(relPath, { size: st.size, text: null, reason: "binary" }); continue; }
      total += st.size;
      files.set(relPath, { size: st.size, text: redact(buf.toString("utf8")) });
    }
  }
  await rec(root, "");
  return { files, totalBytes: total, skipped };
}

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 120000, maxBuffer: 1 << 20 }, (err, _o, stderr) => (err ? reject(new Error(`${cmd} failed: ${String(stderr || err.message).slice(0, 200)}`)) : resolve()));
});

class SnapshotStore {
  constructor({ projects, token = "", fetchImpl = fetch, workDir = os.tmpdir(), maxFileKb = 400, maxTotalMb = 80, log = console.log }) {
    this.projects = new Map(projects.map((p) => [p.id, p]));
    this.token = token; this.fetch = fetchImpl; this.workDir = workDir; this.log = log;
    this.maxFileBytes = maxFileKb * 1024; this.maxTotalBytes = maxTotalMb * 1024 * 1024;
    this.snaps = new Map(); this.inflight = new Map(); this.errors = new Map();
  }

  get(id) { return this.snaps.get(id) || null; }

  status() {
    return [...this.projects.keys()].map((id) => {
      const s = this.snaps.get(id);
      return { id, sha: s ? s.sha.slice(0, 12) : null, fetchedAt: s ? s.fetchedAt : null, files: s ? s.files.size : 0, error: this.errors.get(id) || null };
    });
  }

  /** Builds a snapshot from a directory already on disk (refresh uses it; so do tests). */
  async loadFromDir(id, dir, sha = "local") {
    const idx = await walk(dir, this.maxFileBytes, this.maxTotalBytes);
    const snap = { id, sha, fetchedAt: new Date().toISOString(), ...idx };
    this.snaps.set(id, snap);
    this.errors.delete(id);
    return snap;
  }

  /** Returns the snapshot, fetching it once on first use. Concurrent callers share one download. */
  async ensure(id) {
    return this.get(id) || this.refresh(id);
  }

  refresh(id) {
    if (this.inflight.has(id)) return this.inflight.get(id);
    const p = this._refresh(id).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  async refreshAll() {
    const out = {};
    for (const id of this.projects.keys()) {
      try { const s = await this.refresh(id); out[id] = { ok: true, sha: s.sha.slice(0, 12) }; }
      catch (e) { out[id] = { ok: false, error: String(e.message || e).slice(0, 200) }; }
    }
    return out;
  }

  _headers(accept) {
    const h = { "user-agent": "GQuantsMultiAgent/1.0", accept, "x-github-api-version": "2022-11-28" };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  async _refresh(id) {
    const p = this.projects.get(id);
    if (!p) throw new Error(`unknown project ${id}`);
    try {
      const api = `https://api.github.com/repos/${p.repo}`;
      const shaRes = await this.fetch(`${api}/commits/${encodeURIComponent(p.branch)}`, { headers: this._headers("application/vnd.github.sha") });
      if (!shaRes.ok) throw new Error(`GitHub ${shaRes.status} reading ${p.repo}@${p.branch}${[401, 403, 404].includes(shaRes.status) ? " (check GITHUB_READ_TOKEN: a private repo needs a token with Contents: read)" : ""}`);
      const sha = (await shaRes.text()).trim();
      const cur = this.snaps.get(id);
      if (cur && cur.sha === sha) { cur.fetchedAt = new Date().toISOString(); return cur; }

      const tarRes = await this.fetch(`${api}/tarball/${sha}`, { headers: this._headers("application/vnd.github+json") });
      if (!tarRes.ok) throw new Error(`GitHub ${tarRes.status} downloading ${p.repo}`);
      const buf = Buffer.from(await tarRes.arrayBuffer());
      const tmp = await fsp.mkdtemp(path.join(this.workDir, `snap-${id}-`));
      try {
        const tgz = path.join(tmp, "repo.tgz");
        const out = path.join(tmp, "x");
        await fsp.writeFile(tgz, buf);
        await fsp.mkdir(out);
        await run("tar", ["-xzf", tgz, "-C", out, "--no-same-owner", "--no-same-permissions"]);
        const tops = (await fsp.readdir(out, { withFileTypes: true })).filter((e) => e.isDirectory());
        const root = tops.length === 1 ? path.join(out, tops[0].name) : out;
        const snap = await this.loadFromDir(id, root, sha);
        this.log(`[snapshot] ${id} @ ${sha.slice(0, 12)}: ${snap.files.size} files, ${(snap.totalBytes / 1e6).toFixed(1)} MB text`);
        return snap;
      } finally {
        fs.rm(tmp, { recursive: true, force: true }, () => {});
      }
    } catch (e) {
      this.errors.set(id, String(e.message || e).slice(0, 200));
      throw e;
    }
  }
}

module.exports = { SnapshotStore, safeRelPath, isSecretPath, redact };
