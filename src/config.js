"use strict";
// Every setting is an environment variable. Railway is the only place they live.
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const ids = (v) => String(v || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

function load(e = process.env) {
  return {
    port: int(e.PORT, 8080),
    dataDir: e.DATA_DIR || "/data",

    // --- Telegram: the bot is the only way in
    telegramToken: e.TELEGRAM_BOT_TOKEN || "",
    telegramApiBase: e.TELEGRAM_API_BASE || "https://api.telegram.org", // only changed by the local smoke test
    allowedUserIds: new Set(ids(e.TELEGRAM_ALLOWED_USER_IDS)),
    adminUserIds: new Set(ids(e.TELEGRAM_ADMIN_USER_IDS)),
    allowedGroupIds: new Set(ids(e.TELEGRAM_ALLOWED_GROUP_IDS)),

    // --- Model: xAI Grok is the only model provider (one key). It answers every
    // question and runs the web_research tool (Grok's live web search).
    xaiKey: e.XAI_API_KEY || "",
    grokUrl: e.XAI_API_URL || "https://api.x.ai/v1/chat/completions", // only changed for local testing
    grokModel: e.AGENT_GROK_MODEL || "grok-4.3",
    model: e.AGENT_GROK_MODEL || "grok-4.3",
    fallbackModel: e.AGENT_FALLBACK_MODEL || "",
    grokResearchModel: e.AGENT_GROK_RESEARCH_MODEL || e.AGENT_GROK_MODEL || "grok-4.3",
    maxOutputTokens: int(e.AGENT_MAX_OUTPUT_TOKENS, 8192),

    // --- Data sources the agent READS (optional). No database of its own.
    // The heatmap project holds live market data; without these, live market tools are off.
    heatmapSupabaseUrl: (e.HEATMAP_SUPABASE_URL || "").replace(/\/$/, ""),
    heatmapSupabaseKey: e.HEATMAP_SUPABASE_KEY || "",
    githubToken: e.GITHUB_READ_TOKEN || "",
    // Project databases (read in full; see src/projectdb.js). Each pair is optional.
    busybeeSupabaseUrl: (e.BUSYBEE_SUPABASE_URL || "").replace(/\/$/, ""),
    busybeeSupabaseKey: e.BUSYBEE_SUPABASE_KEY || "",
    finxraySupabaseUrl: (e.FINXRAY_SUPABASE_URL || "").replace(/\/$/, ""),
    finxraySupabaseKey: e.FINXRAY_SUPABASE_KEY || "",
    // "team" (default): project databases only for people whose Telegram is linked in BusyBee.
    // "everyone": anyone who messages the bot can read them.
    projectDataAccess: (e.PROJECT_DATA_ACCESS || "team").toLowerCase() === "everyone" ? "everyone" : "team",
    // BusyBee actions (create / update tasks) through BusyBee's own API.
    busybeeAppUrl: (e.BUSYBEE_APP_URL || "").replace(/\/$/, ""),
    busybeeAgentSecret: e.BUSYBEE_AGENT_SECRET || "",
    // ETI (the research dashboard): full access through its API; work assigned on its Agent page is picked up by polling.
    etiApiUrl: (e.ETI_API_URL || "").replace(/\/$/, ""),
    etiApiKey: e.ETI_API_KEY || "",
    etiPollSeconds: int(e.ETI_POLL_SECONDS, 45),
    etiTaskMaxSteps: int(e.ETI_TASK_MAX_STEPS, 30),
    etiTaskDeadlineMs: int(e.ETI_TASK_DEADLINE_MS, 600000),
    etiNotifyChatIds: ids(e.ETI_NOTIFY_CHAT_IDS), // optional: Telegram chats told when an assigned task finishes
    // GQ XRayDar (technical analysis): its server API. TA_API_SECRET is shared with that server,
    // which also uses it to call /api/chat here for its dashboard agent panel.
    taApiUrl: (e.TA_API_URL || "").replace(/\/$/, ""),
    taApiSecret: e.TA_API_SECRET || "",
    // SEC asks every client to identify itself: "Company name contact@email".
    secUserAgent: e.SEC_USER_AGENT || "",
    // Files sent in a chat stay available for follow-up questions (RAM only, cleared by /new).
    fileMemoryHours: int(e.FILE_MEMORY_HOURS, 6),
    fileMemoryMax: int(e.FILE_MEMORY_MAX, 8),
    waitNoteMs: int(e.WAIT_NOTE_MS, 8000), // "Looking into it…" after this long (0 = never)
    snapshotRefreshMinutes: int(e.SNAPSHOT_REFRESH_MINUTES, 360),
    snapshotMaxFileKb: int(e.SNAPSHOT_MAX_FILE_KB, 400),
    snapshotMaxTotalMb: int(e.SNAPSHOT_MAX_TOTAL_MB, 80),

    // --- Limits
    maxSteps: int(e.AGENT_MAX_STEPS, 12),
    requestDeadlineMs: int(e.AGENT_REQUEST_DEADLINE_MS, 180000),
    // Spend caps in tokens. 0 = no cap (pay as you go). Set them later if needed.
    dailyTokensPerUser: int(e.AGENT_DAILY_TOKENS_PER_USER, 0),
    monthlyTokensGlobal: int(e.AGENT_MONTHLY_TOKENS, 0),
    ratePerMin: int(e.AGENT_RATE_PER_MIN, 12),
    historyTurns: int(e.AGENT_HISTORY_TURNS, 6),
    // Capacity. Every question (Telegram and dashboard) is answered in parallel; these
    // bound how many model calls are in flight at once (the rest wait their turn, they
    // are never dropped) and how many questions one person may have waiting.
    maxParallelModelCalls: int(e.AGENT_MAX_PARALLEL_MODEL_CALLS, 32),
    maxQueuedPerPerson: int(e.AGENT_MAX_QUEUED_PER_PERSON, 4),
    webDeadlineMs: int(e.AGENT_WEB_DEADLINE_MS, 160000), // under the dashboard server's own 170 s wait

    // --- Scheduled tasks (monitoring that runs on its own)
    tasksEnabled: (e.TASKS_ENABLED || "true").toLowerCase() !== "false",
    taskConcurrency: int(e.TASK_CONCURRENCY, 3),
    taskMinIntervalMinutes: int(e.TASK_MIN_INTERVAL_MINUTES, 15),
    taskMaxPerChat: int(e.TASK_MAX_PER_CHAT, 100),
    taskMaxTotal: int(e.TASK_MAX_TOTAL, 500),
    taskMaxSteps: int(e.TASK_MAX_STEPS, 16),
    taskDeadlineMs: int(e.TASK_DEADLINE_MS, 300000),
    taskMaxFailures: int(e.TASK_MAX_FAILURES, 5),
  };
}

module.exports = { load };
