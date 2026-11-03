"use strict";
// Full read access to every project database that is configured: list its tables
// and columns, then query any table with filters, sorting and counts. Read-only:
// these tools only ever SELECT. Only team members (Telegram linked in BusyBee) may
// use them, unless PROJECT_DATA_ACCESS=everyone.
const { cleanRows, isTableAllowed } = require("../projectdb");
const { guardProject, markUsed } = require("./scope");
const { clamp } = require("./util");

const OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in", "contains"];
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const SELECT = /^[A-Za-z0-9_*,\s().:!>-]{1,600}$/;

const HINTS = {
  busybee: "BusyBee (team work app). Key tables: tasks (title, description, status: pending|in_progress|need_help|done|closed, priority: super_high|high|medium|low, due_date, start_date, progress_percent, assigned_to, created_by, task_manager_id, project_id, desk_id, stage_id, personal, is_list, deleted_at, completed_at, created_at), users (id, full_name, email), desks, desk_members (desk_id, user_id, role), projects (name, desk_id), project_members, stages, subtasks (task_id, title, done, assigned_to, due_date), comments (task_id, user_id, content), task_assignors, extension_requests, task_adjustments, activity_log, objectives / key_results (OKRs), timesheet_entries, documents, chat_rooms / chat_messages, notifications. Join people with select, e.g. '*, assignee:users!tasks_assigned_to_fkey(full_name)' or look users up by id.",
  "gq-finxray-us": "GQ FinXray US (US market alerts). Key tables: raw_filings, ai_summaries, alerts, alert_run_log (alerts sent: ticker, feature, impact, tokens), alert_deliveries, poller_runs, poller_error_log, flagged_summaries, stocks, watchlists, users, etf_* (ETF holdings, expenses, performance, managers, listing events), mf_* (mutual-fund holdings, managers, filings), fund_universe.",
  "heatmap-dashboard": "Heatmap dashboard (market data). Key tables: instruments (symbol, name, universe, sector, industry, country, is_active, market_cap_usd), returns_latest (ret_1d … ret_all, price_native, as_of), price_history (instrument_id, date, close, volume), fundamentals, india_volume_daily, tech_* (technical indicators), ingestion_runs (pipeline runs and failures). Prefer the dedicated market tools (find_instrument, screen …) for prices and returns.",
  "gdp-macro-dashboard": "GDP macro dashboard.",
};

function gate(ctx, project) {
  const g = guardProject(ctx, project);
  if (g.error) return g;
  const db = ctx.projectDbs && ctx.projectDbs[g.id];
  if (!db) return { error: `${g.id}'s database is not connected to the agent (its Supabase URL/key are not set on the server).` };
  if (!ctx.member && !ctx.openData) {
    return { error: "Project databases are for the GQuants team only. To get access, link your Telegram in BusyBee (Settings → Telegram), then ask again.", not_a_member: true };
  }
  return { id: g.id, db };
}

function makeTools(selected, projectDbs) {
  const available = selected.filter((p) => projectDbs && projectDbs[p]);
  if (!available.length) return [];
  const hint = available.map((p) => `- ${p}: ${HINTS[p] || ""}`).join("\n");
  return [
    {
      name: "project_tables",
      description: `List the tables in a project's live database, or the columns of one table. Use it before project_query when you are not sure of a table or column name. Databases available:\n${hint}`,
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", enum: available },
          table: { type: "string", description: "optional: one table, to see its columns and types" },
        },
        required: ["project"],
      },
      async run(a, ctx) {
        const g = gate(ctx, a.project); if (g.error) return g;
        markUsed(ctx, g.id);
        const t = await g.db.tables();
        if (a.table) {
          const def = t[a.table];
          if (!def) return { error: `no table "${a.table}" in ${g.id}`, tables: Object.keys(t).sort() };
          return { project: g.id, table: a.table, ...def };
        }
        return { project: g.id, tables: Object.entries(t).sort(([x], [y]) => x.localeCompare(y)).map(([name, d]) => ({ name, columns: Object.keys(d.columns).length, ...(d.description ? { description: d.description } : {}) })) };
      },
    },
    {
      name: "project_query",
      description: "Read rows from any table in a project's live database (read-only). Filter with 'where' (column, op, value), sort, limit, or ask only for a count. 'select' can join related tables PostgREST-style, e.g. '*, users(full_name)'. Use counts for 'how many' questions instead of fetching rows. Dates are ISO strings; times are UTC unless a column says otherwise: convert to IST for people.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", enum: available },
          table: { type: "string" },
          select: { type: "string", description: "columns, default *" },
          where: {
            type: "array",
            description: "filters, all must match",
            items: {
              type: "object",
              properties: {
                column: { type: "string" },
                op: { type: "string", enum: OPS },
                value: { description: "for 'in' an array; for 'is' null, true or false; for like/ilike use % wildcards" },
              },
              required: ["column", "op"],
            },
          },
          order: { type: "string", description: "column to sort by" },
          descending: { type: "boolean" },
          limit: { type: "integer", description: "1-200, default 50" },
          offset: { type: "integer", description: "skip this many rows (paging)" },
          count_only: { type: "boolean", description: "return only the number of matching rows" },
        },
        required: ["project", "table"],
      },
      async run(a, ctx) {
        const g = gate(ctx, a.project); if (g.error) return g;
        const table = String(a.table || "");
        if (!IDENT.test(table)) return { error: "table must be a plain table name" };
        if (!isTableAllowed(table)) return { error: `${table} holds credentials and is never read by the agent` };
        const sel = String(a.select || "*").trim();
        if (!SELECT.test(sel)) return { error: "select may contain column names, *, commas and PostgREST joins only" };
        if (/(password|secret|token|api_?key)/i.test(sel)) return { error: "credential columns are never read" };
        markUsed(ctx, g.id);
        const countOnly = a.count_only === true;
        let q = g.db.from(table).select(countOnly ? "*" : sel, { count: "exact", head: countOnly });
        for (const w of Array.isArray(a.where) ? a.where.slice(0, 20) : []) {
          const col = String(w.column || "");
          if (!/^[A-Za-z_][A-Za-z0-9_.]{0,80}$/.test(col)) return { error: `bad column name "${col.slice(0, 40)}"` };
          if (!OPS.includes(w.op)) return { error: `op must be one of ${OPS.join(", ")}` };
          let v = w.value;
          if (w.op === "in") { if (!Array.isArray(v) || !v.length) return { error: "'in' needs a non-empty array" }; v = v.slice(0, 500); }
          if (w.op === "is" && ![null, true, false].includes(v)) v = v === "null" ? null : v === "true" ? true : v === "false" ? false : null;
          if (w.op === "contains" && !Array.isArray(v) && typeof v !== "object") v = [v];
          q = q[w.op](col, v);
        }
        // BusyBee: someone else's private to-do never shows, and deleted tasks stay hidden unless asked for.
        if (g.id === "busybee" && table === "tasks") {
          const me = ctx.member && ctx.member.userId;
          q = me && /^[0-9a-f-]{36}$/i.test(me) ? q.or(`personal.is.null,personal.eq.false,assigned_to.eq.${me},created_by.eq.${me}`) : q.or("personal.is.null,personal.eq.false");
          if (!(a.where || []).some((w) => w.column === "deleted_at")) q = q.is("deleted_at", null);
        }
        if (!countOnly) {
          if (a.order) {
            if (!IDENT.test(String(a.order))) return { error: "order must be a column name" };
            q = q.order(a.order, { ascending: !a.descending, nullsFirst: false });
          }
          const lim = clamp(a.limit, 1, 200, 50), off = clamp(a.offset, 0, 1e7, 0);
          q = q.range(off, off + lim - 1);
        }
        const r = await q;
        if (r.error) return { error: `${g.id}.${table}: ${r.error.message}`, hint: "Check the table and column names with project_tables." };
        if (countOnly) return { project: g.id, table, count: r.count };
        const rows = cleanRows(r.data || [], { canSeePay: !!(ctx.member && ctx.member.role === "admin") });
        return { project: g.id, table, total_matching: r.count, returned: rows.length, rows };
      },
    },
  ];
}

module.exports = { makeTools, gate, HINTS, OPS };
