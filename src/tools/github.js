"use strict";
// Read-only project history from the GitHub REST API: what changed recently,
// and what one commit changed. The repo comes from the project registry, never
// from the model, and only GET requests are made.
const { clamp } = require("./util");
const { byId } = require("../projects");
const { safeRelPath } = require("../snapshots");
const { guardProject, markUsed } = require("./scope");

const SHA = /^[0-9a-f]{7,40}$/i;

async function gh(ctx, path) {
  const f = ctx.fetch || fetch;
  const headers = { accept: "application/vnd.github+json", "user-agent": "gquants-agent", "x-github-api-version": "2022-11-28" };
  if (ctx.githubToken) headers.authorization = `Bearer ${ctx.githubToken}`;
  const r = await f(`https://api.github.com${path}`, { method: "GET", headers, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`GitHub ${r.status}${[401, 403, 404].includes(r.status) ? " (check GITHUB_READ_TOKEN access)" : ""}`);
  return r.json();
}

function makeTools(selected) {
  if (!selected || !selected.length) return [];
  const project = { type: "string", enum: selected, description: "project id (only selected projects)" };
  return [
    {
      name: "recent_changes",
      kind: "repo",
      description: "Recent commits on a selected project's main branch (newest first): date, author, message. Optionally only commits touching a path, or only the last N days. Use for 'what changed recently / who worked on X / when was Y added'.",
      parameters: {
        type: "object",
        properties: {
          project,
          path: { type: "string", description: "only commits touching this file or folder (optional)" },
          days: { type: "integer", description: "only the last N days (optional, 1-365)" },
          limit: { type: "integer", description: "1-50, default 20" },
        },
        required: ["project"],
      },
      async run(a, ctx) {
        const g = guardProject(ctx, a.project); if (g.error) return g;
        const p = byId.get(g.id);
        const q = new URLSearchParams({ sha: p.branch, per_page: String(clamp(a.limit, 1, 50, 20)) });
        if (a.path) { const rel = safeRelPath(a.path); if (rel === null) return { error: "invalid path" }; if (rel) q.set("path", rel); }
        if (a.days) q.set("since", new Date(Date.now() - clamp(a.days, 1, 365, 30) * 864e5).toISOString());
        const list = await gh(ctx, `/repos/${p.repo}/commits?${q}`);
        markUsed(ctx, g.id);
        return {
          project: g.id, branch: p.branch,
          commits: list.map((c) => ({
            sha: c.sha.slice(0, 12), date: c.commit.author && c.commit.author.date,
            author: (c.commit.author && c.commit.author.name) || (c.author && c.author.login),
            message: String(c.commit.message || "").split("\n").filter(Boolean).slice(0, 4).join(" / ").slice(0, 300),
          })),
        };
      },
    },
    {
      name: "show_commit",
      kind: "repo",
      description: "What one commit in a selected project changed: full message, files changed with +/- counts, and a short diff excerpt per file.",
      parameters: { type: "object", properties: { project, sha: { type: "string", description: "commit sha (7-40 hex characters) from recent_changes" } }, required: ["project", "sha"] },
      async run(a, ctx) {
        const g = guardProject(ctx, a.project); if (g.error) return g;
        if (!SHA.test(String(a.sha || ""))) return { error: "sha must be 7-40 hex characters" };
        const p = byId.get(g.id);
        const c = await gh(ctx, `/repos/${p.repo}/commits/${a.sha}`);
        markUsed(ctx, g.id);
        const { redact, isSecretPath } = require("../snapshots");
        return {
          project: g.id, sha: c.sha.slice(0, 12), date: c.commit.author && c.commit.author.date, author: c.commit.author && c.commit.author.name,
          message: String(c.commit.message || "").slice(0, 2000),
          stats: c.stats,
          files: (c.files || []).slice(0, 25).map((f) => ({ file: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, diff_excerpt: f.patch && !isSecretPath(f.filename) ? redact(f.patch.slice(0, 1500)) : undefined })),
          more_files: (c.files || []).length > 25 ? c.files.length - 25 : undefined,
        };
      },
    },
  ];
}

module.exports = { makeTools };
