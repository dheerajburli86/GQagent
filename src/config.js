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

    // --- Model: DeepInfra is the only model provider
    deepinfraKey: e.DEEPINFRA_API_KEY || "",
    deepinfraUrl: e.DEEPINFRA_API_URL || "https://api.deepinfra.com/v1/openai/chat/completions", // only changed for local testing
    model: e.AGENT_MODEL || "google/gemini-2.5-flash",
    fallbackModel: e.AGENT_FALLBACK_MODEL || "",
    // xAI Grok (optional). Used as the main model when AGENT_PROVIDER=grok, and for the
    // web_research tool (a sourced web search) whenever the key is set.
    agentProvider: (e.AGENT_PROVIDER || "deepinfra").toLowerCase(),
    xaiKey: e.XAI_API_KEY || "",
    grokModel: e.AGENT_GROK_MODEL || "grok-4.3",
    grokResearchModel: e.AGENT_GROK_RESEARCH_MODEL || e.AGENT_GROK_MODEL || "grok-4.3",
    maxOutputTokens: int(e.AGENT_MAX_OUTPUT_TOKENS, 8192),

    // --- Data sources the agent READS (optional). No database of its own.
    // The heatmap project holds live market data; without these, live market tools are off.
    heatmapSupabaseUrl: (e.HEATMAP_SUPABASE_URL || "").replace(/\/$/, ""),
    heatmapSupabaseKey: e.HEATMAP_SUPABASE_KEY || "",
    githubToken: e.GITHUB_READ_TOKEN || "",
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
