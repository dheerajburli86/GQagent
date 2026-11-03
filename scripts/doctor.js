#!/usr/bin/env node
"use strict";
// Checks a configuration end to end before (or after) deploying:
//   node scripts/doctor.js        (reads the environment, or .env next to package.json)
// Read-only apart from a few hundred model tokens for one DeepInfra call. It
// does NOT send any Telegram message: it only asks Telegram who the bot is.
const fs = require("fs");
const path = require("path");

const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const cfg = require("../src/config").load();
const { PROJECTS } = require("../src/projects");
const { TelegramClient } = require("../src/telegram");

let failed = 0, warned = 0;
const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => { failed++; console.log(`  ✘ ${m}`); };
const warn = (m) => { warned++; console.log(`  ! ${m}`); };
const section = (t) => console.log(`\n${t}`);
const scrub = (s) => String(s).split(cfg.telegramToken || "\u0000").join("<token>").split(cfg.deepinfraKey || "\u0000").join("<key>");

async function main() {
  section("Settings");
  if (!cfg.telegramToken) bad("TELEGRAM_BOT_TOKEN is not set (create the bot with @BotFather, Step 1)");
  else ok("TELEGRAM_BOT_TOKEN is set");
  if (!cfg.allowedUserIds.size) ok("access: open to anyone who messages the bot (set TELEGRAM_ALLOWED_USER_IDS to restrict it)");
  else ok(`access: limited to ${cfg.allowedUserIds.size} user(s)`);
  if (cfg.allowedGroupIds.size) ok(`groups: limited to ${cfg.allowedGroupIds.size}`);
  if (!cfg.deepinfraKey) bad("DEEPINFRA_API_KEY is not set: the bot cannot answer");
  else ok(`DEEPINFRA_API_KEY is set; model ${cfg.model}${cfg.fallbackModel ? `, fallback ${cfg.fallbackModel}` : ""}`);
  if (!cfg.githubToken) warn("GITHUB_READ_TOKEN is not set: the four repos cannot be read");
  if (!cfg.xaiKey) warn("XAI_API_KEY not set: no web_research (Grok search); the agent uses its keyless search only");
  else ok(`XAI_API_KEY is set; research model ${cfg.grokResearchModel}${cfg.agentProvider === "grok" ? " (also the main model)" : ""}`);
  if (!cfg.heatmapSupabaseUrl || !cfg.heatmapSupabaseKey) warn("HEATMAP_SUPABASE_URL/KEY not set: live market data questions will be answered from knowledge only");
  ok(`scheduled tasks ${cfg.tasksEnabled ? `on (up to ${cfg.taskConcurrency} at once, shortest interval ${cfg.taskMinIntervalMinutes} min)` : "OFF (TASKS_ENABLED=false)"}`);
  ok(`spend caps: daily per person ${cfg.dailyTokensPerUser || "none"}, monthly ${cfg.monthlyTokensGlobal || "none"}`);
  const fsx = require("fs");
  try { fsx.mkdirSync(cfg.dataDir, { recursive: true }); fsx.accessSync(cfg.dataDir, fsx.constants.W_OK); ok(`DATA_DIR ${cfg.dataDir} is writable`); }
  catch { warn(`DATA_DIR ${cfg.dataDir} is not writable here (fine on your laptop if Railway has the /data volume)`); }

  section("Telegram");
  if (cfg.telegramToken) {
    const tg = new TelegramClient({ token: cfg.telegramToken, apiBase: cfg.telegramApiBase, log: () => {} });
    try {
      const me = await tg.getMe();
      ok(`bot is @${me.username} (${me.first_name})`);
      if (!me.username) bad("the bot has no username: create it again with @BotFather");
    } catch (e) { bad(`Telegram rejected the token: ${scrub(e.message)}`); }
  }

  section("Model (DeepInfra), with the agent's real tool list");
  if (cfg.deepinfraKey) {
    const deepinfra = require("../src/providers/deepinfra");
    const { buildTools } = require("../src/tools/index");
    const tools = buildTools({ selected: PROJECTS.map((p) => p.id), user: { isAdmin: true }, liveOn: !!(cfg.heatmapSupabaseUrl && cfg.heatmapSupabaseKey) });
    for (const model of [cfg.model, cfg.fallbackModel].filter(Boolean)) {
      const p = deepinfra.create({ apiKey: cfg.deepinfraKey, model, maxTokens: 512 });
      try {
        const r = await p.chat({ system: "You are a test. Call the current_time tool once.", messages: [{ role: "user", content: "What time is it?" }], tools });
        if (r.toolCalls.length) ok(`${model}: accepted all ${tools.length} tool schemas and called ${r.toolCalls[0].name} (${r.usage.in}+${r.usage.out} tokens)`);
        else warn(`${model}: answered without calling a tool; tool calling may be unreliable on this model`);
      } catch (e) { bad(`${model}: ${scrub(e.message).slice(0, 240)}`); }
    }
  }

  if (cfg.xaiKey) {
    section("Grok (xAI): web research");
    const research = require("../src/tools/research").makeTool({ apiKey: cfg.xaiKey, model: cfg.grokResearchModel });
    try {
      const r = await research.run({ question: "Reply with the word OK." }, { fetch });
      if (r.error) bad(`web_research: ${r.error}`);
      else ok(`web_research answered (${(r.answer || "").slice(0, 40)}); ${r.sources.length} source link(s) when searching`);
    } catch (e) { bad(`web_research: ${scrub(e.message).slice(0, 200)}`); }
    if (cfg.agentProvider === "grok") {
      const g = require("../src/providers/deepinfra").create({ apiKey: cfg.xaiKey, model: cfg.grokModel, maxTokens: 64, url: require("../src/providers/index").GROK_URL, name: "grok" });
      try { const r = await g.chat({ system: "Reply with OK.", messages: [{ role: "user", content: "ping" }], tools: [] }); ok(`Grok main model answered (${r.usage.in}+${r.usage.out} tokens)`); }
      catch (e) { bad(`Grok main model: ${scrub(e.message).slice(0, 200)}`); }
    }
  }

  section("Repos (GitHub)");
  for (const p of PROJECTS) {
    const headers = { accept: "application/vnd.github.sha", "user-agent": "gquants-agent-doctor", "x-github-api-version": "2022-11-28" };
    if (cfg.githubToken) headers.authorization = `Bearer ${cfg.githubToken}`;
    try {
      const r = await fetch(`https://api.github.com/repos/${p.repo}/commits/${p.branch}`, { headers });
      if (r.ok) ok(`${p.repo}@${p.branch} -> ${(await r.text()).trim().slice(0, 12)}`);
      else bad(`${p.repo}: HTTP ${r.status}${r.status === 404 ? " (private repo: the token needs Contents: read on it)" : ""}`);
    } catch (e) { bad(`${p.repo}: ${e.message}`); }
  }

  if (cfg.heatmapSupabaseUrl && cfg.heatmapSupabaseKey) {
    section("Live market data (heatmap database, read-only)");
    const { createClient } = require("@supabase/supabase-js");
    const { SOURCES } = require("../src/tools/live");
    const sb = createClient(cfg.heatmapSupabaseUrl, cfg.heatmapSupabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
    for (const [key, s] of Object.entries(SOURCES)) {
      for (const t of s.tables) {
        const { error } = await sb.from(t).select("*", { head: true }).limit(1);
        if (error) bad(`${key}: table ${t}: ${error.message}`);
      }
      const { error: e1 } = await sb.rpc("team_agent_overview", { p_universe: "us_stocks" });
      if (e1) bad(`${key}: read function team_agent_overview: ${e1.message}`);
      else ok(`${key}: ${s.tables.length} tables and read functions answer`);
    }
  }

  section("Keyless sources");
  const search = require("../src/tools/search");
  const r = await search.makeTools()[0].run({ query: "Reserve Bank of India" }, { fetch });
  for (const k of ["web", "news", "encyclopedia"]) {
    if (r[k] && r[k].length) ok(`web search (${k}): ${r[k].length} result(s)`);
    else warn(`web search (${k}): ${r.unavailable && r.unavailable[k] ? r.unavailable[k] : "no results"}`);
  }
  const pd = require("../src/tools/public_data").tool;
  for (const [label, args] of [["exchange rates (ECB)", { kind: "fx", symbols: "INR" }], ["crypto prices", { kind: "crypto", symbols: "bitcoin" }], ["weather", { kind: "weather", place: "Mumbai" }]]) {
    try { const x = await pd.run(args, { fetch }); if (x.error) warn(`${label}: ${x.error}`); else ok(`${label} answers`); }
    catch (e) { warn(`${label}: ${String(e.message).slice(0, 120)}`); }
  }
  section("Project databases (full read access for team members)");
  {
    const { buildProjectDbs } = require("../src/projectdb");
    const dbs = buildProjectDbs(process.env);
    if (!Object.keys(dbs).length) warn("no project database is set (BUSYBEE_/FINXRAY_/HEATMAP_SUPABASE_URL and _KEY)");
    for (const [p, db] of Object.entries(dbs)) {
      try { const t = await db.tables(); ok(`${p}: ${Object.keys(t).length} tables readable`); }
      catch (e) { bad(`${p}: ${String(e.message).slice(0, 140)} (check the URL and that the key is the service_role / secret key)`); }
    }
    if (dbs.busybee) {
      try {
        const r = await dbs.busybee.from("user_telegram").select("user_id", { count: "exact", head: true });
        if (r.error) throw new Error(r.error.message);
        ok(`team members (Telegram linked in BusyBee): ${r.count}`);
      } catch (e) { bad(`can't read BusyBee's user_telegram: ${String(e.message).slice(0, 120)}`); }
    } else if (cfg.projectDataAccess !== "everyone") warn("BUSYBEE_SUPABASE_URL/KEY not set: nobody can be recognised as a team member, so project databases stay closed");
    if (cfg.busybeeAppUrl && cfg.busybeeAgentSecret) {
      if (cfg.busybeeAgentSecret.length < 24) bad("BUSYBEE_AGENT_SECRET is shorter than 24 characters; BusyBee will refuse it");
      try {
        const r = await fetch(`${cfg.busybeeAppUrl}/api/tasks`, { method: "PUT", headers: { "content-type": "application/json", "x-agent-secret": "wrong-on-purpose-xxxxxxxxxxxxxxxx", "x-agent-telegram-id": "1" }, body: "{}", signal: AbortSignal.timeout(15000) });
        if (r.status === 401) ok(`BusyBee app answers at ${cfg.busybeeAppUrl} (a wrong secret is refused, as it should be)`);
        else warn(`BusyBee app answered HTTP ${r.status} to a wrong secret; is the agent-auth patch deployed?`);
      } catch (e) { bad(`BusyBee app unreachable: ${String(e.message).slice(0, 120)}`); }
    } else warn("BUSYBEE_APP_URL / BUSYBEE_AGENT_SECRET not set: the bot can read BusyBee but not create or update tasks");
  }

  section("Macro news (country sources)");
  try {
    const mn = require("../src/tools/macro").tool;
    const x = await mn.run({ country: "Japan,United Kingdom,Brazil", days: 14, per_country: 2 }, { fetch });
    for (const c of x.results) {
      if (c.count) ok(`macro news ${c.country}: ${c.count} item(s)${c.items.some((i) => i.official) ? ", incl. official source" : ", press only"}`);
      else warn(`macro news ${c.country}: nothing returned${c.unavailable ? ` (${c.unavailable.join("; ")})` : ""}`);
    }
  } catch (e) { warn(`macro news: ${String(e.message).slice(0, 120)}`); }

  section("Company filings (official sources)");
  if (!cfg.secUserAgent) warn("SEC_USER_AGENT not set: SEC asks for 'Company name contact@email' and may refuse an anonymous client");
  const fil = require("../src/tools/filings").tool;
  for (const [label, args] of [["SEC EDGAR (US filings + financials)", { market: "us", company: "AAPL", days: 120, financials: true, limit: 3 }], ["NSE announcements", { market: "india", company: "INFY", exchange: "nse", days: 60, limit: 3 }], ["BSE announcements", { market: "india", company: "500209", exchange: "bse", days: 60, limit: 3 }]]) {
    try {
      const x = await fil.run(args, { fetch, secUserAgent: cfg.secUserAgent || undefined });
      if (x.error) warn(`${label}: ${x.error}${x.hint ? ` (${x.hint})` : ""}`);
      else ok(`${label}: ${x.matched} item(s) for ${x.company}${x.financials && !x.financials.error ? ", financials read" : ""}`);
    } catch (e) { warn(`${label}: ${String(e.message).slice(0, 120)}`); }
  }
  console.log("    (A refused exchange is not fatal: the agent falls back to the other exchange, then to web research.)");

  const calc = await require("../src/tools/calc").tool.run({ expression: "cagr(100, 250, 5)" });
  if (calc.last && calc.last.startsWith("0.2011")) ok("calculator works"); else bad(`calculator: ${JSON.stringify(calc).slice(0, 160)}`);

  console.log(`\n${failed ? `${failed} problem(s)` : "No problems"}${warned ? `, ${warned} warning(s)` : ""}.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(scrub(e && e.stack || e)); process.exit(1); });
