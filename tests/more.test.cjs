/** Attachments (PDF/CSV/text), public data, GitHub history, PDF via web_fetch. `npm test` (no network). */
const { test } = require("node:test");
const assert = require("node:assert/strict");

const docs = require("../src/documents.js");
const { buildTools } = require("../src/tools/index.js");
const { buildSystemPrompt } = require("../src/prompt.js");
const { IDS } = require("../src/projects.js");

const USER = { id: "u1", email: "a@gquants.com", isAdmin: false };
const tool = (tools, n) => tools.find((t) => t.name === n);

/** A tiny real PDF with one line of text per page. */
function makePdf(pages) {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`];
  const font = 3 + pages.length * 2;
  pages.forEach((t, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 144] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
    const st = `BT /F1 14 Tf 20 80 Td (${t}) Tj ET`;
    objs.push(`<< /Length ${st.length} >>\nstream\n${st}\nendstream`);
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n"; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const CSV = 'region,product,revenue,units\nNorth,"Widget, large",1200.50,10\nSouth,Widget,800,8\nNorth,Gadget,"1,000",5\nEast,Gadget,(200),2\nSouth,Gizmo,,1\n';

// ---- documents -------------------------------------------------------------------
test("documents: PDF text per page; text, HTML; unsupported types rejected; results cached", async () => {
  const pdf = await docs.extract({ name: "AR.pdf", buf: makePdf(["Revenue grew 18 percent", "Net profit was 420 crore"]) });
  assert.equal(pdf.kind, "pdf"); assert.equal(pdf.totalPages, 2);
  assert.deepEqual(pdf.pages, ["Revenue grew 18 percent", "Net profit was 420 crore"]);
  assert.match(pdf.text, /--- page 2 ---\nNet profit/);
  const again = await docs.extract({ name: "copy.pdf", buf: makePdf(["Revenue grew 18 percent", "Net profit was 420 crore"]) });
  assert.equal(again.name, "copy.pdf");
  const html = await docs.extract({ name: "p.html", buf: Buffer.from("<title>T</title><script>evil()</script><p>Hello</p>") });
  assert.match(html.text, /Hello/); assert.ok(!html.text.includes("evil"), "scripts are dropped");
  const txt = await docs.extract({ name: "notes.txt", buf: Buffer.from("﻿line1\nline2") });
  assert.equal(txt.text, "line1\nline2");
  await assert.rejects(() => docs.extract({ name: "old.xls", buf: Buffer.from("x") }), /can't read this type/);
  await assert.rejects(() => docs.extract({ name: "x.exe", buf: Buffer.from("MZ") }), /can't read this type/);
});

test("CSV: quoted fields, thousands separators, negatives in brackets, profiling and grouping are exact", () => {
  const rows = docs.parseDelimited(CSV);
  assert.deepEqual(rows[1], ["North", "Widget, large", "1200.50", "10"]);
  assert.equal(docs.toNum("1,000"), 1000); assert.equal(docs.toNum("(200)"), -200); assert.equal(docs.toNum("₹ 5,00,000"), 500000); assert.equal(docs.toNum("abc"), null);
  const a = docs.analyzeTable(CSV, { groupBy: "region", valueColumn: "revenue" });
  assert.equal(a.rows, 5);
  const rev = a.columns.find((c) => c.name === "revenue");
  assert.equal(rev.type, "number"); assert.equal(rev.sum, 2800.5); assert.equal(rev.count, 4); assert.equal(rev.missing, 1); assert.equal(rev.min, -200);
  assert.equal(a.columns.find((c) => c.name === "product").type, "text");
  assert.deepEqual(a.grouped.groups.map((g) => [g.group, g.value]), [["North", 2200.5], ["South", 800], ["East", -200]]);
  const f = docs.analyzeTable(CSV, { filterColumn: "product", filterValue: "gadget", groupBy: "region", valueColumn: "units", agg: "mean" });
  assert.equal(f.rows, 2);
  assert.throws(() => docs.analyzeTable(CSV, { groupBy: "nope" }), /no column "nope"/);
  const tsv = docs.analyzeTable("a\tb\n1\t2\n3\t4", { delim: "\t" });
  assert.equal(tsv.columns[1].sum, 6);
});

// ---- attachment tools ----------------------------------------------------------------
test("attachment tools: declared only with files; read by page/offset; search with page numbers; analyze_table", async () => {
  assert.ok(!buildTools({ selected: [], user: USER }).some((t) => t.kind === "files"));
  const pdf = await docs.extract({ name: "AR.pdf", buf: makePdf(["Revenue grew 18 percent", "Net profit was 420 crore. Profit up."]) });
  const csv = await docs.extract({ name: "sales.csv", buf: Buffer.from(CSV) });
  const attached = [pdf, csv];
  const tools = buildTools({ selected: [], user: USER, attached });
  assert.deepEqual(tools.filter((t) => t.kind === "files").map((t) => t.name), ["read_attachment", "search_attachment", "analyze_table"]);
  assert.deepEqual(tool(tools, "analyze_table").parameters.properties.name.enum, ["sales.csv"]);
  const ctx = { attachments: attached };
  assert.equal((await tool(tools, "read_attachment").run({ name: "AR.pdf", page: 2 }, ctx)).text, "Net profit was 420 crore. Profit up.");
  const s = await tool(tools, "search_attachment").run({ name: "ar.pdf", query: "profit" }, ctx);
  assert.equal(s.total_matches, 2); assert.equal(s.matches[0].page, 2);
  const r = await tool(tools, "analyze_table").run({ name: "sales.csv", group_by: "region", value_column: "revenue" }, ctx);
  assert.equal(r.grouped.groups[0].value, 2200.5);
  assert.match((await tool(tools, "read_attachment").run({ name: "other.pdf" }, ctx)).error, /no attachment named/);
  const p = buildSystemPrompt({ user: USER, selected: [], attached, toolNames: [] });
  assert.match(p, /AR\.pdf \(pdf, 2 pages/); assert.match(p, /analyze_table/);
});

// ---- server: attachments over HTTP ---------------------------------------------------
test("web_fetch: reads a PDF URL (e.g. an annual report) and pages long text with offset", async () => {
  const wf = tool(buildTools({ selected: [], user: USER }), "web_fetch");
  const pdf = makePdf(["Annual report 2025", "Revenue 1000 crore"]);
  const f = async () => new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } });
  const r = await wf.run({ url: "http://8.8.8.8/ar.pdf" }, { fetch: f });
  assert.equal(r.total_pages, 2); assert.match(r.text, /Revenue 1000 crore/);
  const long = "x".repeat(40000);
  const r2 = await wf.run({ url: "http://8.8.8.8/a.txt", offset: 15000 }, { fetch: async () => new Response(long, { status: 200, headers: { "content-type": "text/plain" } }) });
  assert.equal(r2.offset, 15000); assert.equal(r2.text.length, 15000); assert.equal(r2.next_offset, 30000);
  await assert.rejects(() => wf.run({ url: "http://8.8.8.8/x.zip" }, { fetch: async () => new Response("PK", { status: 200, headers: { "content-type": "application/zip" } }) }), /unsupported content type/);
});

// ---- public data -----------------------------------------------------------------------
test("public_data: fx (with fallback host), crypto (symbol lookup), weather (geocode + forecast); fixed hosts only", async () => {
  const pd = tool(buildTools({ selected: [], user: USER }), "public_data");
  const hosts = [];
  const f = async (url) => {
    const u = new URL(url); hosts.push(u.host);
    const j = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (u.host === "api.frankfurter.dev") return new Response("down", { status: 502 });
    if (u.host === "api.frankfurter.app") return j({ base: "USD", date: "2026-10-30", rates: { INR: 88.1, EUR: 0.86 } });
    if (u.host === "api.coingecko.com" && u.pathname.endsWith("/search")) return j({ coins: [{ id: "ethereum", symbol: "ETH" }] });
    if (u.pathname.endsWith("/simple/price")) return j({ bitcoin: { usd: 100000, inr: 8800000, usd_24h_change: 1.234, last_updated_at: 1793500000 }, ethereum: { usd: 4000, inr: 350000, usd_24h_change: -2 } });
    if (u.host === "geocoding-api.open-meteo.com") return j({ results: [{ name: "Mumbai", admin1: "Maharashtra", country: "India", latitude: 19.07, longitude: 72.88 }] });
    if (u.host === "api.open-meteo.com") return j({ timezone: "Asia/Kolkata", current: { time: "2026-11-01T14:00", temperature_2m: 31, weather_code: 2 }, daily: { time: ["2026-11-01"], temperature_2m_min: [24], temperature_2m_max: [33], precipitation_sum: [0], precipitation_probability_max: [10], weather_code: [1] } });
    return new Response("?", { status: 404 });
  };
  const fx = await pd.run({ kind: "fx", base: "usd", symbols: "INR, EUR" }, { fetch: f });
  assert.deepEqual(fx.rates, { INR: 88.1, EUR: 0.86 }); assert.equal(fx.date, "2026-10-30");
  assert.match((await pd.run({ kind: "fx", symbols: "INR; DROP" }, { fetch: f })).error, /3-letter/);
  const c = await pd.run({ kind: "crypto", symbols: "bitcoin, ETH" }, { fetch: f });
  assert.deepEqual(c.prices.map((p) => [p.id, p.usd, p.change_24h_pct]), [["bitcoin", 100000, 1.23], ["ethereum", 4000, -2]]);
  const w = await pd.run({ kind: "weather", place: "Mumbai" }, { fetch: f });
  assert.equal(w.place, "Mumbai, Maharashtra, India"); assert.equal(w.current.conditions, "partly cloudy"); assert.equal(w.daily[0].max_c, 33);
  assert.deepEqual([...new Set(hosts)].sort(), ["api.coingecko.com", "api.frankfurter.app", "api.frankfurter.dev", "api.open-meteo.com", "geocoding-api.open-meteo.com"]);
});

// ---- GitHub history ------------------------------------------------------------------------
test("recent_changes / show_commit: scoped to selected projects, GET only, token sent, secrets never shown", async () => {
  const tools = buildTools({ selected: ["busybee"], user: USER });
  const reqs = [];
  const f = async (url, o) => {
    reqs.push({ url, method: o.method, auth: o.headers.authorization });
    if (url.includes("/commits?")) return new Response(JSON.stringify([{ sha: "abcdef1234567890", commit: { author: { name: "Dheeraj", date: "2026-10-14T08:07:09Z" }, message: "Payroll renamed to IROP\n\nDetails here" } }]), { status: 200 });
    return new Response(JSON.stringify({ sha: "abcdef1234567890", commit: { author: { name: "D", date: "x" }, message: "m" }, stats: { additions: 3, deletions: 1 },
      files: [{ filename: "lib/x.ts", status: "modified", additions: 3, deletions: 1, patch: "+const k = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnop1234'" }, { filename: ".env", status: "modified", additions: 1, deletions: 0, patch: "+SECRET=abc" }] }), { status: 200 });
  };
  const ctx = { selected: ["busybee"], fetch: f, githubToken: "ghtok", projectsUsed: new Set() };
  const rc = await tool(tools, "recent_changes").run({ project: "busybee", days: 7, path: "lib/" }, ctx);
  assert.equal(rc.commits[0].message, "Payroll renamed to IROP / Details here");
  assert.match(reqs[0].url, /^https:\/\/api\.github\.com\/repos\/dheerajburli86\/busybee\/commits\?sha=main&per_page=20&path=lib&since=/);
  const sc = await tool(tools, "show_commit").run({ project: "busybee", sha: "abcdef1" }, ctx);
  assert.ok(!sc.files[0].diff_excerpt.includes("eyJhbGci"), "credential in a diff is redacted");
  assert.equal(sc.files[1].diff_excerpt, undefined, ".env diff never shown");
  assert.ok(reqs.every((r) => r.method === "GET" && r.auth === "Bearer ghtok"));
  assert.deepEqual([...ctx.projectsUsed], ["busybee"]);
  assert.equal((await tool(tools, "recent_changes").run({ project: "heatmap-dashboard" }, ctx)).not_selected, true);
  assert.match((await tool(tools, "show_commit").run({ project: "busybee", sha: "../../x" }, ctx)).error, /hex/);
  assert.match((await tool(tools, "recent_changes").run({ project: "busybee", path: "../x" }, ctx)).error, /invalid path/);
  assert.ok(!buildTools({ selected: [], user: USER }).some((t) => t.name === "recent_changes"));
  void IDS;
});
