"use strict";
// Repo knowledge tools over the in-memory snapshots: list_files, read_file,
// grep_code, read_docs. Pure lookups. Nothing here writes, shells out or
// touches the filesystem; grep is a literal substring search (no model-supplied
// regex, so no catastrophic backtracking).
const { clamp } = require("./util");
const { safeRelPath } = require("../snapshots");
const { projectDoc } = require("../projects");
const { guardProject, markUsed } = require("./scope");

const MAX_READ_CHARS = 20000;
const MAX_LINES = 400;

function globToRegex(g) {
  const s = String(g).slice(0, 100).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${s}$`, "i");
}

const isDoc = (p) => {
  const parts = p.split("/"); const base = parts[parts.length - 1];
  if (/^(readme|claude|agents|changelog|contributing)(\.[a-z]+)?$/i.test(base)) return true;
  if (!/\.(md|mdx|rst)$/i.test(base)) return false;
  return parts.length <= 2 || parts[0].toLowerCase() === "docs";
};

/** Common front matter for every tool: resolve the project, check selection, load the snapshot. */
async function open(ctx, project) {
  const g = guardProject(ctx, project);
  if (g.error) return { err: g };
  let snap;
  try { snap = await ctx.store.ensure(g.id); }
  catch (e) { return { err: { error: `Could not load the ${g.id} snapshot: ${String(e.message || e).slice(0, 160)}. Say the project could not be read right now.` } }; }
  markUsed(ctx, g.id);
  return { id: g.id, snap, meta: { project: g.id, commit: snap.sha.slice(0, 12), snapshot_at: snap.fetchedAt } };
}

function projectParam(selected) {
  return { type: "string", enum: selected, description: "project id (only selected projects can be read)" };
}

function makeTools(selected) {
  if (!selected || !selected.length) return []; // general-only turn: no repo tools (an empty enum is also invalid for Gemini)
  const project = projectParam(selected);
  return [
    {
      name: "list_files",
      kind: "repo",
      description: "List files in a selected project's repo snapshot. Filter by directory prefix and/or a glob like '*.sql' or 'pipeline/*.py'.",
      parameters: {
        type: "object",
        properties: {
          project,
          dir: { type: "string", description: "directory prefix, e.g. 'pipeline' (optional)" },
          pattern: { type: "string", description: "glob on the file name, or on the path if it contains '/' (optional)" },
          limit: { type: "integer", description: "1-300, default 150" },
        },
        required: ["project"],
      },
      async run(a, ctx) {
        const o = await open(ctx, a.project); if (o.err) return o.err;
        let dir = "";
        if (a.dir) { dir = safeRelPath(a.dir); if (dir === null) return { error: "invalid dir" }; }
        const re = a.pattern ? globToRegex(a.pattern) : null;
        const pathGlob = a.pattern && String(a.pattern).includes("/");
        const lim = clamp(a.limit, 1, 300, 150);
        const out = []; let total = 0;
        for (const [p, f] of o.snap.files) {
          if (dir && !(p === dir || p.startsWith(dir + "/"))) continue;
          if (re && !re.test(pathGlob ? p : p.split("/").pop())) continue;
          total++;
          if (out.length < lim) out.push(f.text === null ? { path: p, size: f.size, unreadable: f.reason } : { path: p, size: f.size });
        }
        return { ...o.meta, total_matches: total, files: out, truncated: total > out.length };
      },
    },
    {
      name: "read_file",
      kind: "repo",
      description: "Read a text file from a selected project's repo snapshot, optionally a line range. Returns at most 400 lines / 20k characters per call.",
      parameters: {
        type: "object",
        properties: {
          project,
          path: { type: "string", description: "path relative to the repo root, e.g. 'pipeline/db.py'" },
          start_line: { type: "integer", description: "1-based, default 1" },
          end_line: { type: "integer", description: "inclusive" },
        },
        required: ["project", "path"],
      },
      async run(a, ctx) {
        const rel = safeRelPath(a.path);
        if (rel === null || rel === "") return { error: "invalid path: use a path relative to the repo root, without '..'" };
        const o = await open(ctx, a.project); if (o.err) return o.err;
        const f = o.snap.files.get(rel);
        if (!f) return { ...o.meta, error: `no such file: ${rel}. Use list_files or grep_code to find it.` };
        if (f.text === null) return { ...o.meta, path: rel, error: `file is ${f.reason} (${f.size} bytes) and cannot be read as text` };
        const lines = f.text.split("\n");
        const start = clamp(a.start_line, 1, Math.max(1, lines.length), 1);
        const end = clamp(a.end_line, start, lines.length, Math.min(lines.length, start + MAX_LINES - 1));
        let body = lines.slice(start - 1, Math.min(end, start + MAX_LINES - 1)).join("\n");
        const cut = body.length > MAX_READ_CHARS;
        if (cut) body = body.slice(0, MAX_READ_CHARS);
        const shownEnd = Math.min(end, start + MAX_LINES - 1);
        return { ...o.meta, path: rel, start_line: start, end_line: shownEnd, total_lines: lines.length, content: body, truncated: cut, more_after: shownEnd < lines.length };
      },
    },
    {
      name: "grep_code",
      kind: "repo",
      description: "Search a selected project's repo snapshot for a literal string (not a regex). Returns matching lines with paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          project,
          query: { type: "string", description: "literal text to find, 2-200 characters" },
          dir: { type: "string", description: "limit to this directory prefix (optional)" },
          case_sensitive: { type: "boolean", description: "default false" },
          limit: { type: "integer", description: "1-100 matching lines, default 40" },
        },
        required: ["project", "query"],
      },
      async run(a, ctx) {
        const q = String(a.query || "");
        if (q.length < 2 || q.length > 200) return { error: "query must be 2-200 characters" };
        let dir = "";
        if (a.dir) { dir = safeRelPath(a.dir); if (dir === null) return { error: "invalid dir" }; }
        const o = await open(ctx, a.project); if (o.err) return o.err;
        const cs = a.case_sensitive === true;
        const needle = cs ? q : q.toLowerCase();
        const lim = clamp(a.limit, 1, 100, 40);
        const matches = []; let filesHit = 0, total = 0;
        for (const [p, f] of o.snap.files) {
          if (f.text === null || (dir && !p.startsWith(dir + "/") && p !== dir)) continue;
          const hay = cs ? f.text : f.text.toLowerCase();
          if (!hay.includes(needle)) continue;
          filesHit++;
          const lines = f.text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const l = cs ? lines[i] : lines[i].toLowerCase();
            if (!l.includes(needle)) continue;
            total++;
            if (matches.length < lim) matches.push({ path: p, line: i + 1, text: lines[i].trim().slice(0, 240) });
          }
        }
        return { ...o.meta, query: q, files_with_matches: filesHit, total_matches: total, matches, truncated: total > matches.length };
      },
    },
    {
      name: "read_docs",
      kind: "repo",
      description: "Start here for a project. Without `doc`: the project's overview (from PROJECTS.md) and the list of its documentation files. With `doc`: that documentation file's text, paged by `offset`.",
      parameters: {
        type: "object",
        properties: {
          project,
          doc: { type: "string", description: "path of a doc file from the list, e.g. 'CLAUDE.md' (optional)" },
          offset: { type: "integer", description: "character offset for long docs, default 0" },
        },
        required: ["project"],
      },
      async run(a, ctx) {
        const o = await open(ctx, a.project); if (o.err) return o.err;
        const docs = [...o.snap.files.keys()].filter(isDoc).slice(0, 60);
        if (!a.doc) return { ...o.meta, overview: projectDoc(o.id), docs };
        const rel = safeRelPath(a.doc);
        if (rel === null) return { error: "invalid doc path" };
        const f = o.snap.files.get(rel);
        if (!f || f.text === null) return { ...o.meta, error: `no readable doc at ${rel}`, docs };
        const off = clamp(a.offset, 0, Math.max(0, f.text.length - 1), 0);
        const text = f.text.slice(off, off + MAX_READ_CHARS);
        return { ...o.meta, doc: rel, offset: off, length: f.text.length, text, next_offset: off + text.length < f.text.length ? off + text.length : null };
      },
    },
  ];
}

module.exports = { makeTools, globToRegex, isDoc };
