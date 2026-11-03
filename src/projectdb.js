"use strict";
// One read handle per project database. Every project with a Supabase URL and key
// in the environment is readable in full: every table, every column, every row,
// with three exceptions that never leave the database:
//   - tables that hold credentials (secrets, tokens, sessions, push endpoints)
//   - columns whose name says they hold a credential (password, token, api_key ...)
//   - pay and bank details, except for people who are BusyBee admins
// Our code only ever calls select on these handles. Changing BusyBee goes through
// BusyBee's own API (tools/busybee.js), never through this file.
const DB_ENV = {
  "heatmap-dashboard": ["HEATMAP_SUPABASE_URL", "HEATMAP_SUPABASE_KEY"],
  busybee: ["BUSYBEE_SUPABASE_URL", "BUSYBEE_SUPABASE_KEY"],
  "gq-finxray-us": ["FINXRAY_SUPABASE_URL", "FINXRAY_SUPABASE_KEY"],
  "gdp-macro-dashboard": ["GDP_SUPABASE_URL", "GDP_SUPABASE_KEY"],
};

const SECRET_TABLE = /(^|_)(secrets?|tokens?|sessions?|credentials?|api_keys?|push_subscriptions|telegram_link_tokens|refresh_tokens|otp|passwords?)($|_)/i;
const SECRET_COL = /(password|passwd|secret|(^|_)token($|_)|access_token|refresh_token|api_?key|private_?key|service_?key|bot_token|webhook_secret|otp|totp|hash$|(^|_)endpoint($|_)|p256dh|(^|_)auth$)/i;
const PAY_COL = /(salary|ctc|wage|payroll|pay_?rate|hourly_rate|bonus|bank|ifsc|account_?(no|number)|iban|pan(_?no|_?number)?$|aadhaar|aadhar|tax_?id|ssn)/i;

const isTableAllowed = (t) => !SECRET_TABLE.test(t);
const SENSITIVE = { SECRET_TABLE, SECRET_COL, PAY_COL };

class ProjectDb {
  constructor({ project, url, key, fetchImpl = fetch, client }) {
    this.project = project;
    this.url = String(url).replace(/\/$/, "");
    this.key = key;
    this.fetch = fetchImpl;
    this.client = client || require("@supabase/supabase-js").createClient(this.url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    this.schema = null;
    this.schemaAt = 0;
  }

  headers() {
    const h = { apikey: this.key, accept: "application/openapi+json, application/json" };
    if (/^eyJ/.test(this.key)) h.authorization = `Bearer ${this.key}`; // legacy JWT keys; new sb_secret_ keys go in apikey only
    return h;
  }

  /** {table: {description, columns: {name: {type, format, description}}}} from PostgREST's own description. Cached 30 min. */
  async tables(force = false) {
    if (this.schema && !force && Date.now() - this.schemaAt < 30 * 60e3) return this.schema;
    const r = await this.fetch(`${this.url}/rest/v1/`, { headers: this.headers(), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`could not list the ${this.project} tables (HTTP ${r.status})`);
    const j = await r.json();
    const defs = j.definitions || (j.components && j.components.schemas) || {};
    const out = {};
    for (const [name, d] of Object.entries(defs)) {
      if (!isTableAllowed(name)) continue;
      const cols = {};
      for (const [c, p] of Object.entries(d.properties || {})) {
        if (SECRET_COL.test(c)) continue;
        cols[c] = { type: p.format || p.type, ...(p.description ? { description: String(p.description).slice(0, 200) } : {}) };
      }
      out[name] = { ...(d.description ? { description: String(d.description).slice(0, 300) } : {}), columns: cols };
    }
    this.schema = out;
    this.schemaAt = Date.now();
    return out;
  }

  /** The only data call: a SELECT. */
  from(table) {
    const q = this.client.from(table);
    return { select: (cols, opts) => q.select(cols, opts) };
  }
}

/** Builds a ProjectDb for every project whose URL and key are set. */
function buildProjectDbs(env = process.env, { fetchImpl = fetch, makeClient } = {}) {
  const out = {};
  for (const [project, [u, k]] of Object.entries(DB_ENV)) {
    const url = (env[u] || "").trim(), key = (env[k] || "").trim();
    if (url && key) out[project] = new ProjectDb({ project, url, key, fetchImpl, client: makeClient ? makeClient(url, key) : undefined });
  }
  return out;
}

/** Removes credential columns always, and pay/bank columns unless the reader is a BusyBee admin. */
function cleanRows(rows, { canSeePay = false } = {}) {
  const scrub = (v) => {
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        if (SECRET_COL.test(k)) continue;
        if (!canSeePay && PAY_COL.test(k)) { o[k] = "(hidden: admins only)"; continue; }
        o[k] = scrub(x);
      }
      return o;
    }
    if (typeof v === "string" && v.length > 2000) return `${v.slice(0, 2000)}… (${v.length} characters)`;
    return v;
  };
  return scrub(rows);
}

module.exports = { ProjectDb, buildProjectDbs, cleanRows, isTableAllowed, DB_ENV, SENSITIVE };
