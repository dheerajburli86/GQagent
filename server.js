"use strict";
// GQuants Agent: one research agent with two front doors, Telegram and the
// GQ XRayDar dashboard's agent panel. Every question runs in parallel: the
// Telegram poll never waits for an answer, each chat / person has its own queue,
// and a shared limiter bounds how many model calls are in flight (the rest wait
// their turn). One replica (Telegram allows one poller per token, and the
// per-person limits and the in-RAM conversation memory live here).
//
//   GET  /health     Railway's health check (also reports load)
//   POST /api/chat   the dashboard panel, via ta-server (x-ta-secret = TA_API_SECRET)
//   Telegram         long polling
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

const tg = new TelegramClient({ token: cfg.telegramToken, apiBase: cfg.telegramApiBase, log });
const { Semaphore, limitProvider } = require("./src/limit");
const modelSlots = new Semaphore(cfg.maxParallelModelCalls);
const provider = limitProvider(createProvider(cfg), modelSlots);
const engines = { grok: provider };
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

if (!provider) log("[agent] XAI_API_KEY is not set: the bot will reply that the model is not configured");
if (!cfg.githubToken) log("[agent] GITHUB_READ_TOKEN is not set: private repos cannot be read");
if (!Object.keys(live).length) log("[agent] HEATMAP_SUPABASE_URL/KEY not set: live market tools are off");

const researchTool = cfg.xaiKey ? require("./src/tools/research").makeTool({ apiKey: cfg.xaiKey, model: cfg.grokResearchModel }) : null;
if (!cfg.xaiKey) log("[agent] XAI_API_KEY not set: web_research (Grok search) is off");
// ETI: full access through its API, plus work assigned on the dashboard's Agent page.
const { EtiClient } = require("./src/tools/eti");
const eti = new EtiClient({ url: cfg.etiApiUrl, key: cfg.etiApiKey });
log(`[agent] ETI: ${eti.ready ? `connected (${cfg.etiApiUrl}); polling assigned tasks every ${cfg.etiPollSeconds}s` : "not connected (set ETI_API_URL and ETI_API_KEY)"}`);
// GQ XRayDar: its own calculations through its server API (read-only).
const { XRayDarClient } = require("./src/tools/xraydar");
const xraydar = new XRayDarClient({ url: cfg.taApiUrl, secret: cfg.taApiSecret });
log(`[agent] GQ XRayDar: ${xraydar.ready ? `connected (${cfg.taApiUrl})` : "not connected (set TA_API_URL and TA_API_SECRET)"}; dashboard /api/chat: ${cfg.taApiSecret ? "on" : "off (set TA_API_SECRET)"}`);
const bot = new Bot({ cfg, tg, provider, engines, projectDbs, team, store, snapshots, live, limiter: new RateLimiter(cfg.ratePerMin), log, researchTool, eti, xraydar });

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
const inflight = new Set(); // Telegram handlers and dashboard requests still running
const crypto = require("crypto");
const secretOk = (got) => {
  const want = cfg.taApiSecret;
  if (!want || typeof got !== "string" || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
};
const sendJson = (res, code, obj) => {
  if (res.headersSent) return;
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
};
const readBody = (req, max = 256 * 1024) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on("data", (c) => { size += c.length; if (size > max) { reject(Object.assign(new Error("request too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
  req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(Object.assign(new Error("body is not JSON"), { status: 400 })); } });
  req.on("error", reject);
});
let stopping = false;

const server = http.createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  if (req.method === "GET" && path === "/health") {
    return sendJson(res, 200, { ok: true, model: provider ? provider.model : null, live: Object.keys(live).length > 0, telegram: bot.me ? `@${bot.me.username}` : "starting", dashboard: !!cfg.taApiSecret, xraydar: xraydar.ready, busy: { running: inflight.size, modelCalls: modelSlots.active, waitingForModel: modelSlots.waiting } });
  }
  if (req.method === "POST" && path === "/api/chat") {
    if (!secretOk(String(req.headers["x-ta-secret"] || ""))) return sendJson(res, 401, { error: "secret missing or wrong" });
    if (stopping) return sendJson(res, 503, { error: "the agent is restarting; ask again in a few seconds" });
    const job = (async () => {
      try {
        const b = await readBody(req);
        const out = await bot.webAsk({ user: b.user || {}, message: b.message, history: b.history, context: b.context });
        sendJson(res, 200, out);
      } catch (e) {
        const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
        if (status === 500) log(`[api] error: ${String(e.stack || e).slice(0, 300)}`);
        sendJson(res, status, { error: status === 500 ? "the agent hit an error; please try again" : e.message });
      }
    })();
    inflight.add(job); job.finally(() => inflight.delete(job));
    return job;
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
});
server.requestTimeout = 0; // answers can take a few minutes; the agent's own deadline bounds them
server.headersTimeout = 60000;
server.keepAliveTimeout = 65000;

(async () => {
  await new Promise((r) => server.listen(cfg.port, r));
  log(`[agent] health on ${cfg.port}; model: ${provider ? `${provider.name}/${provider.model}` : "NOT CONFIGURED"}${researchTool ? `; research: grok/${cfg.grokResearchModel}` : ""}`);
  try { await bot.init(); }
  catch (e) { log(`[bot] could not start: ${String(e.message).split(cfg.telegramToken).join("<token>")}`); process.exit(1); }
  if (cfg.tasksEnabled) { runner.start(ac.signal); log(`[tasks] scheduler on: ${store.listTasks().filter((t) => t.enabled).length} active task(s), up to ${cfg.taskConcurrency} at a time`); }
  else log("[tasks] TASKS_ENABLED=false: scheduled tasks will not run");
  if (eti.ready) {
    const { EtiTaskWorker } = require("./src/etitasks");
    const notify = cfg.etiNotifyChatIds.length ? async (text) => { for (const c of cfg.etiNotifyChatIds) await tg.sendPlain(c, text).catch(() => {}); } : null;
    new EtiTaskWorker({ cfg, eti, engines, snapshots, live, liveOn: false, researchTool, store, log, notify }).start(ac.signal);
  }
  setTimeout(() => snapshots.refreshAll().then((r) => log("[snapshot] warm: " + JSON.stringify(r))), 2000);
  if (cfg.snapshotRefreshMinutes > 0) setInterval(() => snapshots.refreshAll().catch(() => {}), cfg.snapshotRefreshMinutes * 60e3).unref();
  await poll(tg, (u) => bot.handle(u), { signal: ac.signal, onError: (e) => log(`[telegram] ${e.message}`), inflight });
})();

// On a deploy, stop taking new work, let answers already being written finish
// (up to 60 s), then exit. The new container takes over the Telegram poll.
const stop = async () => {
  if (stopping) return;
  stopping = true;
  log(`[agent] shutting down; finishing ${inflight.size} answer(s) in progress`);
  ac.abort();
  setTimeout(() => process.exit(0), 60000).unref();
  await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, 58000))]);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
