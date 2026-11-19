"use strict";
// ETI (the early-technology-identification research dashboard): full access through its own API.
//   eti_schema  tables and columns of the ETI database
//   eti_sql     any SELECT over the ETI database (read-only at the database level)
//   eti_api     any ETI API route: GET reads, POST does work (queue fetches, file links, retry jobs, ...)
// Same gate as the other project tools: selected project, and a GQuants team member (or an assigned task).
const { markUsed } = require("./scope");

class EtiClient {
  constructor({ url, key, fetchImpl = fetch }) {
    this.url = String(url || "").replace(/\/$/, "");
    this.key = key || "";
    this.fetch = fetchImpl;
  }
  get ready() { return !!(this.url && this.key); }

  async request(method, path, { query, body, timeoutMs = 60000 } = {}) {
    if (!/^\/[A-Za-z0-9_\-./{}%]*$/.test(path)) throw new Error("bad path");
    const qs = query && Object.keys(query).length ? "?" + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString() : "";
    const r = await this.fetch(`${this.url}${path}${qs}`, {
      method,
      headers: { "x-api-key": this.key, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 2000) }; }
    if (!r.ok) return { error: (data && (data.detail || data.error)) ? String(data.detail || data.error).slice(0, 500) : `ETI API returned HTTP ${r.status}`, status: r.status };
    return data;
  }
}

const ROUTES = `Main ETI API routes (all take JSON; ids are numbers):
READ  GET /companies?q=&status=&dataset=&started=true&limit=   search companies (id, symbol, name, sector, completeness per dataset)
READ  GET /companies/{id}   one company with its documents and data status
READ  GET /companies/{id}/statements · /companies/{id}/prices · /companies/{id}/screener-view
READ  GET /documents/{id}   what was extracted from a document; GET /documents/{id}/view  readable text or a PDF link
READ  GET /started-companies · /left · /gaps · /completeness/summary · /jobs · /backfill/progress · /integrations/status
READ  GET /characteristics · /characteristics/companies · /reports · /reports/{id} · /research/runs
READ  GET /links/batches · /links/batches/{id}   bulk document intake batches and what happened to each link
WORK  POST /links/submit {text, name?, doc_type?, company_id?}   file links / pasted JSON / XBRL: finds the company, converts, stores
WORK  POST /links/items/{id}/resolve {company_id, doc_type?, period_label?} · /links/items/{id}/ignore · /links/items/{id}/retry · /links/batches/{id}/retry
WORK  POST /companies/{id}/refresh {datasets?, mode?}   re-collect a company's data
WORK  POST /gaps/fetch {company_ids: [..] | null}   queue everything still missing
WORK  POST /companies/import · /screener/pull · /backfill/start · /backfill/{id}/cancel
WORK  POST /research {prompt}   run a research question over the ETI data
WORK  POST /agent/tasks {title, instruction, company_id?}   hand work to yourself later`;

function gate(ctx) {
  if (!ctx.selected || !ctx.selected.includes("eti")) return { error: 'Project "eti" is not selected for this conversation. Tell the user to add ETI in the project picker.', not_selected: true };
  if (!ctx.eti) return { error: "ETI is not connected to the agent (ETI_API_URL / ETI_API_KEY are not set on the server)." };
  if (!ctx.etiTask && !ctx.member && !ctx.openData) {
    return { error: "ETI data is for the GQuants team only. To get access, link your Telegram in BusyBee (Settings → Telegram), then ask again.", not_a_member: true };
  }
  return { ok: true };
}

function makeTools(selected, eti) {
  if (!eti || !eti.ready || !selected.includes("eti")) return [];
  return [
    {
      name: "eti_schema",
      description: "List the tables and columns of the ETI database (companies, income_statements, balance_sheets, documents, document_chunks, processing_jobs, company_data_completeness, research_evidence, link_items, agent_tasks ...). Use it before eti_sql when unsure of a name.",
      parameters: { type: "object", properties: { table: { type: "string", description: "optional: only this table" } } },
      async run(a, ctx) {
        const g = gate(ctx); if (g.error) return g; markUsed(ctx, "eti");
        const r = await ctx.eti.request("GET", "/agent/schema");
        if (r && r.error) return r;
        return a.table ? (r || []).filter((t) => t.table_name === a.table) : (r || []).map((t) => t.table_name);
      },
    },
    {
      name: "eti_sql",
      description: "Run any single SELECT (or WITH ... SELECT) over the ETI Postgres database. Read-only, 20 s limit, at most 1000 rows. Use it for any question about what is in ETI: counts, joins, what is missing, job status, documents, evidence. Prefer counts and aggregates over dumping rows.",
      parameters: { type: "object", properties: { sql: { type: "string" }, limit: { type: "integer", description: "row cap, default 200" } }, required: ["sql"] },
      async run(a, ctx) {
        const g = gate(ctx); if (g.error) return g; markUsed(ctx, "eti");
        return ctx.eti.request("POST", "/agent/query", { body: { sql: String(a.sql || ""), limit: a.limit || 200 } });
      },
    },
    {
      name: "eti_api",
      description: `Call the ETI dashboard's API. GET reads. POST does work and takes effect immediately: queueing fetches, filing links, retrying jobs. Do only what the person (or the assigned task) asked, and say exactly what you did.\n${ROUTES}`,
      parameters: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST"] },
          path: { type: "string", description: "e.g. /companies/253 or /links/submit" },
          query: { type: "object", description: "query-string parameters (GET)" },
          body: { type: "object", description: "JSON body (POST)" },
        },
        required: ["method", "path"],
      },
      async run(a, ctx) {
        const g = gate(ctx); if (g.error) return g; markUsed(ctx, "eti");
        const method = String(a.method || "GET").toUpperCase();
        if (method !== "GET" && method !== "POST") return { error: "only GET and POST are supported" };
        if (method === "POST" && !ctx.etiWrite) return { error: "making changes in ETI is not allowed in this run; reading only" };
        if (/^\/agent\/tasks\/(claim|\d+\/report)/.test(a.path)) return { error: "that route belongs to the task runner" };
        const r = await ctx.eti.request(method, String(a.path || ""), { query: a.query, body: method === "POST" ? (a.body || {}) : undefined });
        if (method === "POST" && ctx.audit) { try { await ctx.audit({ tool: "eti_api", args: { method, path: a.path }, ok: !(r && r.error), ms: 0 }); } catch { /* never break a turn */ } }
        return r;
      },
    },
  ];
}

module.exports = { EtiClient, makeTools, gate, ROUTES };
