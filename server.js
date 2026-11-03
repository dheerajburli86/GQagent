"use strict";
// GQuants Agent: a Telegram bot in front of a read-only research agent.
// One process, ONE replica (Telegram allows one poller per token; the
// per-person limits and the in-RAM conversation memory live here too).
//
//   GET /health   the only HTTP route: Railway's health check
//   Telegram      long polling, no public URL needed
const http = require("http");
const os = require("os");
const cfgMod = require("./src/config");
const { TelegramClient, poll } = require("./src/telegram");
const { Bot } = require("./src/bot");
const { Store, RateLimiter } = require("./src/state");
const { PROJECTS } = require("./src/projects");
const { SnapshotStore } = require("./src/snapshots");
const { createProvider } = require("./src/providers/index");
const { buildLiveClients } = require("./src/tools/live");

const cfg = cfgMod.load();
const log = (m) => console.log(new Date().toISOString().slice(0, 19) + " " + m);

if (!cfg.telegramToken) { console.error("TELEGRAM_BOT_TOKEN is not set (see DEPLOY.md, Step 1)."); process.exit(1); }
if (!cfg.allowedUserIds.size) { console.error("TELEGRAM_ALLOWED_USER_IDS is empty: nobody could use the bot. Set your Telegram ID (send /whoami to the bot)."); process.exit(1); }

const tg = new TelegramClient({ token: cfg.telegramToken, apiBase: cfg.telegramApiBase, log });
const provider = createProvider(cfg);
const engines = require("./src/engines").createEngines(cfg);
const store = new Store(cfg.dataDir, log);
const snapshots = new SnapshotStore({ projects: PROJECTS, token: cfg.githubToken, workDir: os.tmpdir(), maxFileKb: cfg.snapshotMaxFileKb, maxTotalMb: cfg.snapshotMaxTotalMb, log });

// Optional live market data: a read-only handle to the heatmap database.
let live = {};
if (cfg.heatmapSupabaseUrl && cfg.heatmapSupabaseKey) {
  const { createClient } = require("@supabase/supabase-js");
  const sb = createClient(cfg.heatmapSupabaseUrl, cfg.heatmapSupabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
  live = buildLiveClients(sb);
}

// Every project database that has a URL and key set: read in full by team members.
const { buildProjectDbs } = require("./src/projectdb");
const { Team } = require("./src/team");
const projectDbs = buildProjectDbs(process.env);
const team = new Team({ busybee: projectDbs.busybee || null, log });
log(`[agent] project databases: ${Object.keys(projectDbs).join(", ") || "none"}; access: ${cfg.projectDataAccess === "everyone" ? "everyone" : team.available ? "team members (Telegram linked in BusyBee)" : "nobody yet (set BUSYBEE_SUPABASE_URL/KEY to identify team members)"}; BusyBee actions: ${cfg.busybeeAppUrl && cfg.busybeeAgentSecret ? "on" : "off"}`);

if (!provider) log("[agent] DEEPINFRA_API_KEY is not set: the bot will reply that the model is not configured");
if (!cfg.githubToken) log("[agent] GITHUB_READ_TOKEN is not set: private repos cannot be read");
if (!Object.keys(live).length) log("[agent] HEATMAP_SUPABASE_URL/KEY not set: live market tools are off");

const researchTool = cfg.xaiKey ? require("./src/tools/research").makeTool({ apiKey: cfg.xaiKey, model: cfg.grokResearchModel }) : null;
if (!cfg.xaiKey) log("[agent] XAI_API_KEY not set: web_research (Grok search) is off");
const bot = new Bot({ cfg, tg, provider, engines, projectDbs, team, store, snapshots, live, limiter: new RateLimiter(cfg.ratePerMin), log, researchTool });

// Scheduled monitoring tasks: post to the chat that created them.
const { TaskRunner } = require("./src/tasks");
const { toTelegramMessages } = require("./src/format");
const runner = new TaskRunner({
  cfg, store, provider, engines, projectDbs, team, snapshots, live, liveOn: Object.keys(live).length > 0, researchTool, log,
  isChatAllowed: (chatId) => require("./src/access").chatAllowed(cfg, chatId),
  post: async (chatId, markdown, { taskId } = {}) => {
    const parts = toTelegramMessages(markdown);
    for (let i = 0; i < parts.length; i++) {
      // The last part of a task update carries a one-tap pause button.
      const extra = taskId && i === parts.length - 1 ? { reply_markup: bot.updateButtons(taskId) } : {};
      try { await tg.sendMessage(chatId, parts[i], extra); }
      catch (e) {
        if (e.code === 400 && /parse|entit/i.test(e.message)) await tg.sendPlain(chatId, parts[i].replace(/<[^>]+>/g, ""), extra);
        else throw e;
      }
    }
  },
});
bot.runner = runner;

const ac = new AbortController();
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url.split("?")[0] === "/health") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, model: provider ? provider.model : null, live: Object.keys(live).length > 0, telegram: bot.me ? `@${bot.me.username}` : "starting" }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
});

(async () => {
  await new Promise((r) => server.listen(cfg.port, r));
  log(`[agent] health on ${cfg.port}; model: ${provider ? `${provider.name}/${provider.model}` : "NOT CONFIGURED"}${researchTool ? `; research: grok/${cfg.grokResearchModel}` : ""}`);
  try { await bot.init(); }
  catch (e) { log(`[bot] could not start: ${String(e.message).split(cfg.telegramToken).join("<token>")}`); process.exit(1); }
  if (cfg.tasksEnabled) { runner.start(ac.signal); log(`[tasks] scheduler on: ${store.listTasks().filter((t) => t.enabled).length} active task(s), up to ${cfg.taskConcurrency} at a time`); }
  else log("[tasks] TASKS_ENABLED=false: scheduled tasks will not run");
  setTimeout(() => snapshots.refreshAll().then((r) => log("[snapshot] warm: " + JSON.stringify(r))), 2000);
  if (cfg.snapshotRefreshMinutes > 0) setInterval(() => snapshots.refreshAll().catch(() => {}), cfg.snapshotRefreshMinutes * 60e3).unref();
  await poll(tg, (u) => bot.handle(u), { signal: ac.signal, onError: (e) => log(`[telegram] ${e.message}`) });
})();

const stop = () => { log("[agent] shutting down"); ac.abort(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
