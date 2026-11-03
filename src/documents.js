"use strict";
// Turns an uploaded file or a downloaded PDF into text the agent can read.
// Supported: PDF (text layer; scanned image-only PDFs have none), Excel (.xlsx:
// every sheet becomes its own table), Word (.docx), PowerPoint (.pptx), and any
// text format (txt, csv, tsv, md, json, html, xml, code, logs). Office files are
// zip archives of XML; they are unzipped in memory and nothing is executed. Results are cached
// by content hash, because the page re-sends a conversation's attachments on
// every turn.
const crypto = require("crypto");
const { htmlToText } = require("./tools/web");

const MAX_TEXT = 600_000; // characters kept per document
const cache = new Map();   // sha256 -> extracted doc (LRU, small)

const TEXT_EXT = /\.(txt|csv|tsv|md|markdown|json|jsonl|xml|html?|log|py|js|mjs|cjs|ts|tsx|jsx|sql|yaml|yml|toml|ini|env\.example|sh|r|ipynb)$/i;

function kindOf(name, mime = "") {
  const n = String(name || "").toLowerCase();
  if (n.endsWith(".pdf") || /pdf/.test(mime)) return "pdf";
  if (/\.(xlsx|xlsm)$/.test(n) || /spreadsheetml/.test(mime)) return "xlsx";
  if (/\.docx$/.test(n) || /wordprocessingml/.test(mime)) return "docx";
  if (/\.pptx$/.test(n) || /presentationml/.test(mime)) return "pptx";
  if (/\.(csv)$/.test(n) || /csv/.test(mime)) return "csv";
  if (/\.(tsv)$/.test(n) || /tab-separated/.test(mime)) return "tsv";
  if (/\.html?$/.test(n) || /html/.test(mime)) return "html";
  if (TEXT_EXT.test(n) || /^text\/|json|xml/.test(mime)) return "text";
  return null;
}

async function pdfPages(buf) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  return { totalPages, pages: (Array.isArray(text) ? text : [text]).map((t) => String(t || "").replace(/[ \t]+\n/g, "\n").trim()) };
}

// ---- Office (xlsx / docx / pptx) -----------------------------------------------
const MAX_UNZIPPED = 80 * 1024 * 1024; // refuse zip bombs
const xmlText = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");

function unzip(buf, keep) {
  const { unzipSync, strFromU8 } = require("fflate");
  let total = 0;
  const files = unzipSync(new Uint8Array(buf), { filter: (f) => { if (!keep(f.name)) return false; total += f.originalSize; if (total > MAX_UNZIPPED) throw new Error("file expands to more than 80 MB"); return true; } });
  const out = {};
  for (const [k, v] of Object.entries(files)) out[k] = strFromU8(v);
  return out;
}

const colIndex = (ref) => { let n = 0; for (const ch of String(ref).replace(/\d+/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const csvCell = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Excel: one CSV table per sheet, in workbook order, with sheet names. */
function xlsxSheets(buf) {
  const f = unzip(buf, (n) => /^xl\/(workbook\.xml|sharedStrings\.xml|_rels\/workbook\.xml\.rels|worksheets\/sheet\d+\.xml)$/.test(n));
  const shared = [];
  for (const m of (f["xl/sharedStrings.xml"] || "").matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(xmlText([...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  const rels = {};
  for (const m of (f["xl/_rels/workbook.xml.rels"] || "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0]), target = /Target="([^"]+)"/.exec(m[0]);
    if (id && target) rels[id[1]] = "xl/" + target[1].replace(/^\/?xl\//, "").replace(/^\//, "");
  }
  const sheets = [];
  for (const m of (f["xl/workbook.xml"] || "").matchAll(/<sheet\b[^>]*>/g)) {
    const nm = /name="([^"]*)"/.exec(m[0]), rid = /r:id="([^"]+)"/.exec(m[0]);
    const path = rid && rels[rid[1]];
    if (nm && path && f[path]) sheets.push({ name: xmlText(nm[1]), xml: f[path] });
  }
  return sheets.map(({ name, xml }) => {
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], body = c[2] || "";
        const ref = /r="([A-Z]+)\d+"/.exec(attrs);
        const t = (/t="([^"]+)"/.exec(attrs) || [])[1];
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        let val = "";
        if (t === "s") val = shared[+v] ?? "";
        else if (t === "inlineStr") val = xmlText([...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""));
        else if (t === "b") val = v === "1" ? "TRUE" : "FALSE";
        else if (v !== undefined) val = xmlText(v);
        const idx = ref ? colIndex(ref[1]) : row.length;
        while (row.length < idx) row.push("");
        row[idx] = val;
      }
      while (row.length && row[row.length - 1] === "") row.pop();
      rows.push(row);
    }
    while (rows.length && !rows[rows.length - 1].length) rows.pop();
    return { name, rows, csv: rows.map((r) => r.map((x) => csvCell(String(x))).join(",")).join("\n") };
  }).filter((s) => s.rows.length);
}

/** Word: paragraphs (tables come out row by row, cells separated by " | "). */
function docxText(buf) {
  const f = unzip(buf, (n) => n === "word/document.xml");
  const xml = f["word/document.xml"] || "";
  const out = [];
  for (const block of xml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>|<w:p\b[\s\S]*?<\/w:p>/g)) {
    const b = block[0];
    if (b.startsWith("<w:tr")) {
      const cells = [...b.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) => [...c[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((t) => xmlText(t[1])).join("").trim());
      out.push(cells.join(" | "));
    } else {
      const t = [...b.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((x) => (x[1] !== undefined ? xmlText(x[1]) : x[0] === "<w:tab/>" ? "\t" : "\n")).join("");
      out.push(t);
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** PowerPoint: text per slide, in order. */
function pptxSlides(buf) {
  const f = unzip(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  return Object.keys(f).sort((a, b) => +/(\d+)\.xml$/.exec(a)[1] - +/(\d+)\.xml$/.exec(b)[1])
    .map((k) => [...f[k].matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)].map((p) => [...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => xmlText(t[1])).join("")).filter(Boolean).join("\n"));
}

/** Like extract(), but a workbook comes back as one table per sheet. Returns an array of docs. */
async function extractAll({ name, mime, buf }) {
  if (kindOf(name, mime) !== "xlsx") return [await extract({ name, mime, buf })];
  let sheets;
  try { sheets = xlsxSheets(buf); } catch (e) { throw new Error(`${name}: could not open this Excel file (${String(e.message).slice(0, 80)}). Re-save it as .xlsx and try again.`); }
  if (!sheets.length) throw new Error(`${name}: the workbook has no data in any sheet.`);
  return sheets.map((s) => ({
    name: sheets.length === 1 ? name : `${name} [${s.name}]`, kind: "csv", text: s.csv.slice(0, MAX_TEXT), chars: s.csv.length, truncated: s.csv.length > MAX_TEXT,
    note: `Excel sheet "${s.name}", ${s.rows.length} rows. Dates appear as Excel serial numbers (days since 1899-12-30); formulas show their last saved value.`,
  }));
}

/** buf: Buffer. Returns {name, kind, text, pages?, totalPages?, chars, truncated, note?}. */
async function extract({ name, mime, buf }) {
  const kind = kindOf(name, mime);
  if (!kind) throw new Error(`${name}: I can't read this type of file. Send PDF, Excel (.xlsx), Word (.docx), PowerPoint (.pptx), CSV or text. Old .xls/.doc/.ppt files: open and save them in the new format first.`);
  const key = crypto.createHash("sha256").update(buf).digest("hex");
  if (cache.has(key)) { const c = cache.get(key); cache.delete(key); cache.set(key, c); return { ...c, name }; }

  let doc;
  if (kind === "pdf") {
    const { totalPages, pages } = await pdfPages(buf);
    const text = pages.map((p, i) => `--- page ${i + 1} ---\n${p}`).join("\n\n");
    const empty = pages.every((p) => !p.trim());
    doc = { kind, pages, totalPages, text: text.slice(0, MAX_TEXT), chars: text.length, truncated: text.length > MAX_TEXT,
      note: empty ? "This PDF has no text layer (probably a scan), so its content cannot be read." : undefined };
  } else if (kind === "docx" || kind === "pptx") {
    let text;
    try {
      if (kind === "docx") text = docxText(buf);
      else text = pptxSlides(buf).map((t, i) => `--- slide ${i + 1} ---\n${t}`).join("\n\n");
    } catch (e) { throw new Error(`${name}: could not open this file (${String(e.message).slice(0, 80)}).`); }
    doc = { kind: "text", text: text.slice(0, MAX_TEXT), chars: text.length, truncated: text.length > MAX_TEXT,
      note: !text.trim() ? "The file has no readable text (it may be all images)." : kind === "pptx" ? "PowerPoint slide text only; pictures and charts are not read." : undefined };
  } else if (kind === "xlsx") {
    const sheets = xlsxSheets(buf);
    const text = sheets.map((s) => `--- sheet: ${s.name} ---\n${s.csv}`).join("\n\n");
    doc = { kind: "text", text: text.slice(0, MAX_TEXT), chars: text.length, truncated: text.length > MAX_TEXT };
  } else {
    let text = buf.toString("utf8").replace(/^﻿/, "");
    if (kind === "html") text = htmlToText(text).text;
    doc = { kind, text: text.slice(0, MAX_TEXT), chars: text.length, truncated: text.length > MAX_TEXT };
  }
  cache.set(key, doc);
  while (cache.size > 30) cache.delete(cache.keys().next().value);
  return { ...doc, name };
}

// ---- CSV ---------------------------------------------------------------------
/** RFC-4180-ish parser: quoted fields, doubled quotes, CRLF. */
function parseDelimited(text, delim = ",") {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"' && field === "") q = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const toNum = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/[,₹$€£%\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!s || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  return Number(s);
};

function stats(nums) {
  const v = nums.filter((x) => x !== null).sort((a, b) => a - b);
  if (!v.length) return null;
  const n = v.length, sum = v.reduce((s, x) => s + x, 0), mean = sum / n;
  const q = (p) => { const k = (n - 1) * p, f = Math.floor(k); return v[f] + (v[Math.min(f + 1, n - 1)] - v[f]) * (k - f); };
  const sd = n > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const r = (x) => Number(x.toPrecision(10));
  return { count: n, sum: r(sum), mean: r(mean), median: r(q(0.5)), min: v[0], max: v[n - 1], p25: r(q(0.25)), p75: r(q(0.75)), std: r(sd) };
}

/** Profiles a table and optionally aggregates value_column by group_by. */
function analyzeTable(text, { delim = ",", groupBy, valueColumn, agg = "sum", filterColumn, filterValue, top = 25 } = {}) {
  const rows = parseDelimited(text, delim);
  if (rows.length < 2) return { error: "the table needs a header row and at least one data row" };
  const header = rows[0].map((h, i) => String(h).trim() || `col_${i + 1}`);
  let data = rows.slice(1).filter((r) => r.some((c) => String(c).trim() !== ""));
  const col = (name) => {
    if (name === undefined || name === null || name === "") return -1;
    const i = header.findIndex((h) => h.toLowerCase() === String(name).toLowerCase());
    if (i < 0) throw new Error(`no column "${name}". Columns: ${header.join(", ")}`);
    return i;
  };
  if (filterColumn) {
    const fi = col(filterColumn); const want = String(filterValue ?? "").toLowerCase();
    data = data.filter((r) => String(r[fi] ?? "").toLowerCase() === want);
  }
  const columns = header.map((h, i) => {
    const vals = data.map((r) => r[i]);
    const nums = vals.map(toNum);
    const numeric = nums.filter((x) => x !== null).length >= Math.max(1, Math.ceil(vals.filter((x) => String(x ?? "").trim() !== "").length * 0.8));
    if (numeric) return { name: h, type: "number", ...stats(nums), missing: vals.length - nums.filter((x) => x !== null).length };
    const counts = new Map();
    for (const v of vals) { const k = String(v ?? "").trim(); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
    return { name: h, type: "text", distinct: counts.size, top_values: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([value, n]) => ({ value, n })) };
  });
  const out = { rows: data.length, columns, first_rows: data.slice(0, 5).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]]))) };
  if (groupBy) {
    const gi = col(groupBy), vi = valueColumn ? col(valueColumn) : -1;
    const groups = new Map();
    for (const r of data) {
      const k = String(r[gi] ?? "").trim() || "(blank)";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(vi >= 0 ? toNum(r[vi]) : 1);
    }
    const AGG = { sum: (s) => s && s.sum, mean: (s) => s && s.mean, median: (s) => s && s.median, min: (s) => s && s.min, max: (s) => s && s.max, count: (s) => s && s.count };
    const f = AGG[agg] || AGG.sum;
    const res = [...groups.entries()].map(([k, v]) => ({ group: k, value: vi >= 0 ? f(stats(v)) : v.length, rows: v.length }));
    res.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
    out.grouped = { by: header[gi], value: vi >= 0 ? `${agg}(${header[vi]})` : "count", groups: res.slice(0, Math.min(200, top)), total_groups: res.length };
  }
  return out;
}

module.exports = { extract, extractAll, xlsxSheets, docxText, pptxSlides, kindOf, parseDelimited, analyzeTable, toNum, MAX_TEXT };
