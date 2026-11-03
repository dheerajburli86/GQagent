"use strict";
// Tools over files the user attached to the conversation (PDF, CSV, text...).
// Declared only when the request carries attachments. Attachments live in the
// request, never on disk, so nothing here touches the filesystem.
const { clamp } = require("./util");
const { analyzeTable } = require("../documents");

const PAGE = 20000;
const byName = (ctx, name) => {
  const list = ctx.attachments || [];
  const n = String(name || "").trim().toLowerCase();
  return list.find((d) => d.name.toLowerCase() === n) || (list.length === 1 && !n ? list[0] : null);
};
const missing = (ctx, name) => ({ error: `no attachment named "${String(name).slice(0, 80)}". Attached: ${(ctx.attachments || []).map((d) => d.name).join(", ") || "none"}` });

function makeTools(attachments) {
  if (!attachments || !attachments.length) return [];
  const names = attachments.map((d) => d.name);
  const nameParam = { type: "string", enum: names, description: "attached file name" };
  const tools = [
    {
      name: "read_attachment",
      description: "Read text from a file the user attached. Long files are returned 20,000 characters at a time: use offset to page through, or `page` for one PDF page.",
      parameters: { type: "object", properties: { name: nameParam, offset: { type: "integer", description: "character offset, default 0" }, page: { type: "integer", description: "PDF page number (1-based), optional" } }, required: ["name"] },
      async run(a, ctx) {
        const d = byName(ctx, a.name); if (!d) return missing(ctx, a.name);
        if (d.note) return { name: d.name, note: d.note };
        if (a.page && d.pages) {
          const p = clamp(a.page, 1, d.pages.length, 1);
          return { name: d.name, page: p, total_pages: d.pages.length, text: d.pages[p - 1].slice(0, PAGE) };
        }
        const off = clamp(a.offset, 0, Math.max(0, d.text.length - 1), 0);
        const text = d.text.slice(off, off + PAGE);
        return { name: d.name, kind: d.kind, offset: off, length: d.text.length, total_pages: d.totalPages, text, next_offset: off + text.length < d.text.length ? off + text.length : null, truncated_at_upload: d.truncated || undefined };
      },
    },
    {
      name: "search_attachment",
      description: "Find a word or phrase inside an attached file (literal, case-insensitive). Returns matching passages with page numbers for PDFs. Use it to locate things in long documents such as annual reports before reading around them.",
      parameters: { type: "object", properties: { name: nameParam, query: { type: "string", description: "text to find, 2-200 characters" }, limit: { type: "integer", description: "1-40, default 15" } }, required: ["name", "query"] },
      async run(a, ctx) {
        const d = byName(ctx, a.name); if (!d) return missing(ctx, a.name);
        const q = String(a.query || "").trim();
        if (q.length < 2 || q.length > 200) return { error: "query must be 2-200 characters" };
        const lim = clamp(a.limit, 1, 40, 15);
        const needle = q.toLowerCase();
        const units = d.pages ? d.pages.map((t, i) => ({ page: i + 1, t })) : [{ page: null, t: d.text }];
        const hits = []; let total = 0;
        for (const u of units) {
          const low = u.t.toLowerCase();
          let i = low.indexOf(needle);
          while (i >= 0) {
            total++;
            if (hits.length < lim) hits.push({ page: u.page || undefined, at: i, passage: u.t.slice(Math.max(0, i - 220), i + needle.length + 220).replace(/\s+/g, " ").trim() });
            i = low.indexOf(needle, i + needle.length);
          }
        }
        return { name: d.name, query: q, total_matches: total, matches: hits };
      },
    },
  ];
  if (attachments.some((d) => d.kind === "csv" || d.kind === "tsv")) {
    const tables = attachments.filter((d) => d.kind === "csv" || d.kind === "tsv").map((d) => d.name);
    tools.push({
      name: "analyze_table",
      description: "Profile an attached CSV/TSV exactly: row count, every column's type, numeric statistics (count, sum, mean, median, min, max, quartiles, std) and top values; optionally filter rows and group (e.g. total revenue by region). Use this instead of reading a large table and adding numbers yourself.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", enum: tables, description: "attached CSV/TSV file name" },
          group_by: { type: "string", description: "column to group by (optional)" },
          value_column: { type: "string", description: "numeric column to aggregate per group (optional; default: row count)" },
          agg: { type: "string", enum: ["sum", "mean", "median", "min", "max", "count"], description: "default sum" },
          filter_column: { type: "string", description: "keep only rows where this column equals filter_value (optional)" },
          filter_value: { type: "string" },
          top: { type: "integer", description: "groups to return, default 25" },
        },
        required: ["name"],
      },
      async run(a, ctx) {
        const d = byName(ctx, a.name); if (!d) return missing(ctx, a.name);
        try {
          return { name: d.name, ...analyzeTable(d.text, { delim: d.kind === "tsv" ? "\t" : ",", groupBy: a.group_by, valueColumn: a.value_column, agg: a.agg, filterColumn: a.filter_column, filterValue: a.filter_value, top: clamp(a.top, 1, 200, 25) }) };
        } catch (e) { return { error: String(e.message || e).slice(0, 300) }; }
      },
    });
  }
  return tools;
}

module.exports = { makeTools };
