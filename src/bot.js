"use strict";
// The Telegram front end: who may ask, how a message becomes a question, the
// commands, the project picker, attachments, and the answer.
const { check, label } = require("./access");
const { PROJECTS, IDS, byId } = require("./projects");
const { runAgent } = require("./agent");
const { parseEngines, runWithEngines, LABEL: ENGINE_LABEL } = require("./engines");
const dbwrite = require("./tools/dbwrite");
const { buildTools } = require("./tools/index");
const { buildSystemPrompt, withProjectsFooter } = require("./prompt");
const { toTelegramMessages, esc } = require("./format");
const { extractAll, kindOf } = require("./documents");
const { HttpError, BudgetError } = require("./errors");
const { istDay } = require("./state");
const schedule = require("./schedule");

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;

const BRIEF_PROMPT = `Write today's short market brief for the team (under 12 lines).
Use the heatmap live tools: market_overview for India and US (sector averages), and screen for the top 3 gainers and top 3 losers by 1-day return in each. State each as_of date. Then 2-3 bullets on what stands out (for example which sectors led and lagged), describing the data only. No buy, sell or hold views and no predictions. If the live data is missing or stale, say so instead of guessing.
Finally, call watchlists: if the team has a holdings list, add up to 5 lines on its biggest 1-day movers (find_instrument / get_instrument for each, skipping any not in the data). If there is no such list, leave this out silently.`;

const MENU = { market: "📊 Market today", updates: "🔔 My updates", lists: "⭐ Our stocks", help: "❓ How to use" };
const MENU_KEYBOARD = { keyboard: [[{ text: MENU.market }, { text: MENU.updates }], [{ text: MENU.lists }, { text: MENU.help }]], resize_keyboard: true, is_persistent: true };
const MENU_INLINE = { inline_keyboard: [[{ text: MENU.market, callback_data: "m:market" }, { text: MENU.updates, callback_data: "m:updates" }], [{ text: MENU.lists, callback_data: "m:lists" }, { text: MENU.help, callback_data: "m:help" }]] };

const WEB_BRIEF_PROMPT = `Write today's short market summary for the team (under 12 lines), from the latest news: how Indian (Nifty, Sensex) and US (S&P 500, Nasdaq) markets did, the main reasons, and anything big coming up today. Give the date of each figure and the source links. Describe only: no buy, sell or hold views and no predictions.`;

const HELP = `<b>Hi! I'm the GQuants Assistant.</b>
Just type your question, the way you'd message a colleague. English, Hindi or Hinglish are all fine.

<b>Try asking</b>
• "What's the latest news on Infosys?"
• "How did the Indian market do today?"
• Send a PDF, Excel, Word or PowerPoint file and ask about it
• "What is 18% of 2.5 lakh?"

<b>Regular updates</b>
Tell me what you want and when, for example:
• "Every morning at 9, send me news on our India stocks"
• "Tell me straight away if anything big happens with TCS"
I'll send them here. Tap 🔔 <b>My updates</b> to see, pause or remove them.

<b>Buttons</b>
📊 Market today · 🔔 My updates · ⭐ Our stocks · ❓ How to use

<b>Choose the AI</b> (optional)
Normally DeepInfra answers. Add <b>@grok</b> to use Grok and its live web search, or <b>@grok @deepinfra</b> to have both work on it and get one combined answer.

I share facts, not buy or sell advice.`;

const ADVANCED_HELP = `<b>Shortcuts</b> (optional; you can always just type in plain words)
/market  today's market summary
/updates  your regular updates
/lists  our stock lists
/new  start a fresh conversation
/projects  which GQuants projects I may read (for tech questions)
/whoami  your Telegram ID

<b>Admins</b>
/updates all  every chat's updates
/list add india-holdings Titan, Bajaj Finance  (also create, remove, set, delete)
/task add daily 08:30 | what to watch  (also run, pause, resume, delete, schedule, edit)
/status  model, data and spend
/changes  the last changes made through me
/refresh  reload the project code`;

class Bot {
  constructor({ cfg, tg, provider, engines = null, store, snapshots, live, limiter, now = () => new Date(), log = console.log, researchTool = null, runner = null, projectDbs = null, team = null }) {
    Object.assign(this, { cfg, tg, provider, store, snapshots, live, limiter, now, log, researchTool, runner, projectDbs, team });
    // engines: { deepinfra, grok }. Without them (older callers, tests) the one provider is DeepInfra.
    this._engines = engines;
    this.pending = new dbwrite.PendingChanges(); // changes waiting for the person to tap Confirm (RAM only)
    this.me = null;
    this.queues = new Map();   // chatId -> promise chain (one question at a time per chat)
    this.history = new Map();  // chatId -> [{role, content}] (RAM only)
    this.files = new Map();    // chatId -> [{doc, at}] files sent recently, for follow-up questions (RAM only)
    this.liveOn = Object.keys(live || {}).length > 0;
  }

  get engines() { return this._engines || { deepinfra: this.provider || null, grok: null }; }

  async init() {
    this.me = await this.tg.getMe();
    await this.tg.deleteWebhook().catch(() => {});
    const who = this.cfg.allowedUserIds.size ? `${this.cfg.allowedUserIds.size} allowed user(s)` : "open to anyone";
    this.log(`[bot] @${this.me.username} ready (${who})`);
  }

  // ---------------------------------------------------------------- routing
  async handle(update) {
    if (update.callback_query) return this.onCallback(update.callback_query);
    if (update.message) return this.onMessage(update.message);
  }

  async onMessage(m) {
    const chat = m.chat, from = m.from;
    if (!from || !chat) return;
    const access = check(this.cfg, { chat, from });
    if (!access.ok && access.silent && /^\/whoami(@\S+)?\s*$/i.test(String(m.text || "").trim()) && this.cfg.allowedUserIds.has(String(from.id))) {
      // An allowed person can learn an unlisted group's chat ID, to add it to the allowlist. Nothing else is answered there.
      return this.tg.sendPlain(chat.id, `Chat ID: ${chat.id}\nAdd this to TELEGRAM_ALLOWED_GROUP_IDS to let the agent work here.`).catch(() => {});
    }
    if (!access.ok) {
      if (access.reason === "not-allowed" && chat.type === "private") {
        // Tell the person their ID so an admin can add it. Reveals only their own ID.
        await this.tg.sendPlain(chat.id, `Hi! I'm GQuants' private assistant, so I only talk to people on the team list.\n\nPlease send this number to your admin so they can add you: ${from.id}`).catch(() => {});
      }
      this.log(`[bot] ignored message from ${from.id} in ${chat.type} (${access.reason})`);
      return;
    }

    let text = String(m.text || m.caption || "").trim();
    const isGroup = chat.type !== "private";
    const mention = this.me && this.me.username ? new RegExp(`@${this.me.username}\\b`, "i") : null;
    const replyingToBot = m.reply_to_message && m.reply_to_message.from && this.me && m.reply_to_message.from.id === this.me.id;
    if (isGroup) {
      const addressed = text.startsWith("/") || (mention && mention.test(text)) || replyingToBot;
      if (!addressed) return; // in groups, speak only when called
      if (mention) text = text.replace(new RegExp(`@${this.me.username}\\b`, "ig"), "").trim();
    }

    const attachments = m.document ? [m.document] : [];
    if (m.photo && !text) return this.reply(m, "I can't read photos yet. If it's a document, send it as a file instead (📎 → File): PDF, Excel, Word, PowerPoint or CSV.");

    const menu = Object.entries(MENU).find(([, label]) => label === text);
    if (menu) return this.menuAction(m, menu[0], access);
    if (text.startsWith("/")) return this.command(m, text, access);

    // A reply to an earlier message (a task update, someone's note) carries that message as context.
    const quoted = m.reply_to_message && String(m.reply_to_message.text || m.reply_to_message.caption || "").trim();
    if (quoted && text) text = `(Replying to this earlier message:\n"""\n${quoted.slice(0, 3000)}\n""")\n\n${text}`;

    if (!this.limiter.take(String(from.id))) return this.reply(m, "You're sending messages quickly. Give it a minute and try again.");
    if (!this.engines.deepinfra && !this.engines.grok) { this.log("[bot] no model: set DEEPINFRA_API_KEY or XAI_API_KEY"); return this.reply(m, "I'm not fully set up yet. Please let the admin know."); }
    return this.enqueue(chat.id, () => this.ask(m, { text: text || (attachments.length ? "I've sent you a file. Give a short summary of what it is and its key points, then suggest two or three useful things you could do with it." : ""), attachments, access }));
  }

  enqueue(chatId, job) {
    const key = String(chatId);
    const prev = this.queues.get(key) || Promise.resolve();
    const next = prev.then(job, job).catch((e) => this.log(`[bot] job failed: ${String(e && e.message || e).slice(0, 200)}`));
    this.queues.set(key, next);
    next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); });
    return next;
  }

  // ---------------------------------------------------------------- commands
  async command(m, text, access) {
    const [raw, ...rest] = text.split(/\s+/);
    const cmd = raw.toLowerCase().replace(/@.*$/, "");
    const chatId = m.chat.id;
    switch (cmd) {
      case "/start":
      case "/help":
      case "/menu":
        return this.menuAction(m, "help", access);
      case "/more":
        return this.tg.sendMessage(chatId, ADVANCED_HELP, { reply_to_message_id: m.message_id }).catch(() => {});
      case "/market":
        return this.menuAction(m, "market", access);
      case "/whoami":
        return this.reply(m, `Telegram ID: ${m.from.id}\nChat ID: ${chatId}\nAdmin: ${access.admin ? "yes" : "no"}`);
      case "/clear":
      case "/new":
        this.history.delete(String(chatId));
        this.files.delete(String(chatId));
        return this.reply(m, "Fresh start: I've forgotten our earlier messages and files in this chat.");
      case "/all":
        this.store.setProjects(chatId, "all");
        return this.reply(m, "Reading all projects.");
      case "/none":
        this.store.setProjects(chatId, []);
        return this.reply(m, "General questions only: I won't read any project.");
      case "/projects":
        return this.showProjects(chatId);
      case "/brief":
        return this.enqueue(chatId, () => this.ask(m, { text: BRIEF_PROMPT, attachments: [], access, projects: this.liveOn ? ["heatmap-dashboard"] : [] }));
      case "/changes": {
        const rows = this.store.recentAudit(10);
        return this.reply(m, rows.length ? `Recent changes made through me:\n\n${rows.map((r) => `${String(r.at).slice(0, 16).replace("T", " ")} UTC · ${r.by || "?"} · ${r.summary || `${r.action} ${r.project}.${r.table}`}${r.ok === false ? " (failed)" : ""}`).join("\n")}` : "No changes have been made through me yet.");
      }
      case "/tasks":
      case "/updates":
      case "/alerts":
        if ((rest[0] || "").toLowerCase() === "all") {
          if (!access.admin) return this.reply(m, "Only admins can see every chat's updates.");
          return this.taskList(m, { all: true });
        }
        return this.updatesView(m);
      case "/lists":
        return this.listCommand(m, "", access);
      case "/list":
        return this.listCommand(m, text.slice(raw.length).trim(), access);
      case "/task":
        return this.taskCommand(m, text.slice(raw.length).trim(), access);
      case "/status":
        if (!access.admin) return this.reply(m, "Only admins can see status.");
        return this.reply(m, this.statusText());
      case "/refresh":
        if (!access.admin) return this.reply(m, "Only admins can refresh snapshots.");
        return this.refresh(m, rest[0]);
      default:
        return this.reply(m, "I didn't recognise that shortcut. You don't need any: just type what you want in plain words, or tap a button below.");
    }
  }

  statusText() {
    const snaps = this.snapshots.status().map((s) => `• ${s.id}: ${s.sha ? `commit ${s.sha}${s.error ? " (last refresh failed)" : ""}` : "not loaded yet"}`);
    const cap = (n) => (n > 0 ? n.toLocaleString("en-IN") : "no cap");
    const tasks = this.runner ? this.store.listTasks() : [];
    return [
      `Model: ${this.provider ? `${this.provider.name}/${this.provider.model}` : "not configured"}${this.cfg.fallbackModel ? ` (fallback ${this.cfg.fallbackModel})` : ""}`,
      `Web research (Grok): ${this.researchTool ? "on" : "off (no XAI_API_KEY)"}`,
      `Live market data: ${this.liveOn ? "on" : "off (no HEATMAP_SUPABASE_URL/KEY)"}`,
      `Spend this month: ${this.store.spendThisMonth().toLocaleString("en-IN")} tokens (cap: ${cap(this.cfg.monthlyTokensGlobal)})`,
      `Daily cap per person: ${cap(this.cfg.dailyTokensPerUser)}`,
      `Scheduled tasks: ${this.runner ? `${tasks.filter((t) => t.enabled).length} active, ${tasks.filter((t) => !t.enabled).length} paused${this.cfg.tasksEnabled ? "" : " (TASKS_ENABLED=false: none will run)"}` : "off"}`,
      `Repo snapshots:`, ...snaps,
    ].join("\n");
  }

  // ---------------------------------------------------------------- tasks
  taskLine(t) {
    return `#${t.id} ${t.enabled ? "▶" : "⏸"} ${t.title}\n   ${t.schedule}${t.mode === "alerts" ? " · alerts" : ""} · next ${t.enabled ? schedule.fmtIst(t.nextRunAt) : "paused"} · last ${schedule.fmtIst(t.lastRunAt)}${t.lastStatus ? ` (${t.lastStatus})` : ""} · ${(t.tokens || 0).toLocaleString("en-IN")} tokens`;
  }

  // ---------------------------------------------------------------- menu (buttons for people who'd rather tap than type)
  async menuAction(m, action, access) {
    const chatId = m.chat.id;
    const isPrivate = m.chat.type === "private";
    if (action === "help") {
      // Private chats get the persistent button bar; groups get the same buttons under the message.
      return this.tg.sendMessage(chatId, HELP, { reply_markup: isPrivate ? MENU_KEYBOARD : MENU_INLINE }).catch(() => {});
    }
    if (action === "updates") return this.updatesView(m);
    if (action === "lists") return this.listCommand(m, "", access);
    if (action === "market") {
      if (!this.engines.deepinfra && !this.engines.grok) return this.reply(m, "I'm not fully set up yet. Please let the admin know.");
      return this.enqueue(chatId, () => this.ask(m, { text: this.liveOn ? BRIEF_PROMPT : WEB_BRIEF_PROMPT, attachments: [], access, projects: this.liveOn ? ["heatmap-dashboard"] : [] }));
    }
    return undefined;
  }

  /** "🔔 My updates": this chat's regular updates, each with tap-to-run / pause / remove buttons. */
  updatesMessage(chatId, userId, admin) {
    const list = this.store.listTasks(chatId);
    if (!list.length) {
      return { text: "You don't have any regular updates here yet.\n\nJust tell me what you'd like and when, for example:\n• \"Every morning at 9, send me news on our India stocks\"\n• \"Every 2 hours, tell me if anything big happens with Reliance\"", markup: { inline_keyboard: [] } };
    }
    const when = (txt) => String(txt).replace(/^daily/, "Every day").replace(/^weekdays/, "Every weekday").replace(/^weekends/, "Every Saturday and Sunday").replace(/^every/, "Every").replace(/ IST$/, "");
    const lines = list.map((t, i) => `${i + 1}. ${t.enabled ? "" : "⏸ (paused) "}${t.title}\n    ${when(t.schedule)}${t.enabled ? ` · next: ${schedule.fmtIst(t.nextRunAt).replace(" IST", "")}` : ""}`);
    const rows = [];
    list.forEach((t, i) => {
      const mine = admin || String(t.createdBy) === String(userId);
      const row = [{ text: `▶️ Send ${i + 1} now`, callback_data: `t:run:${t.id}` }];
      if (mine) row.push(t.enabled ? { text: `⏸ Pause ${i + 1}`, callback_data: `t:pause:${t.id}` } : { text: `▶ Resume ${i + 1}`, callback_data: `t:resume:${t.id}` }, { text: `🗑 Remove ${i + 1}`, callback_data: `t:del:${t.id}` });
      rows.push(row);
    });
    return { text: `🔔 Regular updates in this chat\n\n${lines.join("\n\n")}\n\nTo add one, just tell me. To change one, tell me in plain words (e.g. "make the Infosys update weekly").`, markup: { inline_keyboard: rows } };
  }

  async updatesView(m) {
    if (!this.runner) return this.reply(m, "Regular updates aren't switched on yet. Please let the admin know.");
    const access = check(this.cfg, { chat: m.chat, from: m.from });
    const v = this.updatesMessage(m.chat.id, m.from && m.from.id, access.admin);
    return this.tg.sendPlain(m.chat.id, v.text, { reply_markup: v.markup }).catch(() => {});
  }

  /** The button under every posted update. */
  updateButtons(taskId) {
    return { inline_keyboard: [[{ text: "⏸ Pause these updates", callback_data: `t:pause:${taskId}` }, { text: "🔔 All my updates", callback_data: "m:updates" }]] };
  }

  async onTaskButton(cq, chat, access, action, id) {
    const t = this.store.getTask(id);
    if (!t || String(t.chatId) !== String(chat.id)) return this.tg.answerCallback(cq.id, "That update no longer exists.");
    const mine = access.admin || String(t.createdBy) === String(cq.from.id);
    if (action !== "run" && !mine) return this.tg.answerCallback(cq.id, "Only the person who set it up (or an admin) can change it.");
    const refresh = async () => {
      const v = this.updatesMessage(chat.id, cq.from.id, access.admin);
      if (/Regular updates in this chat|any regular updates/.test(String(cq.message.text || ""))) {
        await this.tg.call("editMessageText", { chat_id: chat.id, message_id: cq.message.message_id, text: v.text, reply_markup: v.markup, disable_web_page_preview: true }).catch(() => {});
      }
    };
    switch (action) {
      case "run":
        await this.tg.answerCallback(cq.id, "Working on it. It'll arrive here in a minute or two.");
        this.runner.run(t.id, { manual: true });
        return undefined;
      case "pause":
        this.runner.setEnabled(t.id, false);
        await this.tg.answerCallback(cq.id, `Paused: ${t.title}`);
        if (!/Regular updates in this chat/.test(String(cq.message.text || ""))) {
          await this.tg.editKeyboard(chat.id, cq.message.message_id, { inline_keyboard: [[{ text: "▶ Resume these updates", callback_data: `t:resume:${t.id}` }]] });
        }
        return refresh();
      case "resume":
        this.runner.setEnabled(t.id, true);
        await this.tg.answerCallback(cq.id, `Back on: ${t.title}`);
        if (!/Regular updates in this chat/.test(String(cq.message.text || ""))) {
          await this.tg.editKeyboard(chat.id, cq.message.message_id, this.updateButtons(t.id));
        }
        return refresh();
      case "del":
        await this.tg.answerCallback(cq.id);
        return this.tg.editKeyboard(chat.id, cq.message.message_id, { inline_keyboard: [[{ text: `🗑 Yes, remove "${t.title.slice(0, 30)}"`, callback_data: `t:delok:${t.id}` }, { text: "Keep it", callback_data: `t:keep:${t.id}` }]] });
      case "delok":
        this.store.deleteTask(t.id);
        await this.tg.answerCallback(cq.id, `Removed: ${t.title}`);
        return refresh();
      case "keep":
        await this.tg.answerCallback(cq.id);
        return refresh();
      default:
        return this.tg.answerCallback(cq.id);
    }
  }

  // ---------------------------------------------------------------- confirmed changes
  async askToConfirm(chatId, id, replyTo) {
    const p = this.pending.peek(id);
    if (!p) return;
    await this.tg.sendPlain(chatId, `⚠️ Please confirm this change\n\n${dbwrite.summarise(p)}${p.reason ? `\n\nWhy: ${p.reason}` : ""}\n\nNothing has changed yet. Only ${p.by} can confirm. This request expires in 10 minutes.`, {
      reply_to_message_id: replyTo,
      reply_markup: { inline_keyboard: [[{ text: "✅ Yes, make this change", callback_data: `w:ok:${id}` }, { text: "Cancel", callback_data: `w:no:${id}` }]] },
    }).catch(() => {});
  }

  async onChangeButton(cq, chat, action, id) {
    const p = this.pending.peek(id);
    if (!p) { await this.tg.answerCallback(cq.id, "This request has expired. Ask me again."); return this.tg.editKeyboard(chat.id, cq.message.message_id, { inline_keyboard: [] }); }
    if (String(cq.from.id) !== String(p.telegramId)) return this.tg.answerCallback(cq.id, `Only ${p.by} can confirm this.`);
    const finish = (text) => this.tg.call("editMessageText", { chat_id: chat.id, message_id: cq.message.message_id, text, disable_web_page_preview: true, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    if (action === "no") {
      this.pending.take(id);
      await this.tg.answerCallback(cq.id, "Cancelled");
      return finish(`Cancelled. Nothing was changed.\n\n${dbwrite.summarise(p)}`);
    }
    if (action !== "ok") return this.tg.answerCallback(cq.id);
    this.pending.take(id);
    await this.tg.answerCallback(cq.id, "Working…");
    const r = await dbwrite.execute(p, this.projectDbs);
    this.store.addAudit({ project: p.project, table: p.table, action: p.action, count: p.count, by: p.by, telegramId: p.telegramId, summary: dbwrite.summarise(p).split("\n")[0], ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
    this.log(`[change] ${p.by} ${p.action} ${p.project}.${p.table} rows=${p.count} ok=${r.ok}${r.ok ? "" : ` error=${String(r.error).slice(0, 120)}`}`);
    return finish(r.ok ? `✅ Done: ${p.action === "insert" ? "added" : p.action === "update" ? "changed" : "deleted"} ${r.rows} row${r.rows === 1 ? "" : "s"} in ${p.project} › ${p.table}.` : `❌ Not changed: ${r.error}`);
  }

  // ---------------------------------------------------------------- watchlists
  async listCommand(m, rest, access) {
    const send = (t) => this.tg.sendPlain(m.chat.id, t, { reply_to_message_id: m.message_id }).catch(() => {});
    const show = (l) => `${l.name} (${l.items.length})${l.description ? ` - ${l.description}` : ""}\n${l.items.length ? l.items.map((x) => `  • ${x}`).join("\n") : "  (empty)"}`;
    const [sub, ...words] = rest.split(/\s+/).filter(Boolean);
    const action = (sub || "").toLowerCase();
    if (!action) {
      const all = this.store.lists();
      const howTo = access.admin
        ? "To change a list, just tell me, e.g. \"add Titan to our India stocks\" or \"remove Wipro from our India stocks\"."
        : "Only admins can change these lists.";
      if (!all.length) return send(`⭐ No stock lists saved yet.\n\n${access.admin ? "Save one by just telling me, e.g. \"save our India stocks: HDFC Bank, Infosys, TCS\". After that, anyone can ask \"any news on our India stocks?\" and regular updates can follow the list." : "An admin can save the team's stock lists. After that you can ask things like \"any news on our India stocks?\"."}`);
      const nice = (n) => n.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
      return send(`⭐ Our stock lists\n\n${all.map((l) => `${nice(l.name)}${l.description ? ` (${l.description})` : ""}\n${l.items.length ? l.items.map((x) => `  • ${x}`).join("\n") : "  (empty)"}`).join("\n\n")}\n\n${howTo}`);
    }
    const OPS = ["create", "add", "remove", "set", "describe", "delete"];
    if (!OPS.includes(action)) {
      if (action === "help") return send("Usage:\n/lists\n/list <name>\n/list create <name> | <description>\n/list add <name> item, item, ...\n/list remove <name> item, ...\n/list set <name> item, ... (replaces all)\n/list describe <name> | <description>\n/list delete <name>\nItems: company plus ticker, e.g. HDFC Bank (NSE: HDFCBANK). Only admins can change lists.");
      const l = this.store.getList(sub);
      return send(l ? show(l) : `There is no list "${sub}". Send /lists.`);
    }
    if (!access.admin) return send("Only admins can change watchlists.");
    const name = words[0];
    if (!name) return send(`Use: /list ${action} <name> ...  (see /list help)`);
    const after = rest.slice(rest.indexOf(name, sub.length) + name.length).trim();
    let items, description;
    const bar = after.indexOf("|");
    if (action === "describe") description = bar >= 0 ? after.slice(bar + 1).trim() : after;
    else if (action === "create") { items = bar >= 0 ? after.slice(0, bar) : after; description = bar >= 0 ? after.slice(bar + 1).trim() : ""; }
    else items = after;
    if (["add", "remove", "set"].includes(action) && !String(items).trim()) return send(`Give the items, comma-separated: /list ${action} ${name} HDFC Bank (NSE: HDFCBANK), Infosys`);
    const r = this.store.editList(action, name, { items, description, by: label(m.from) });
    if (r.error) return send(`Couldn't change the list: ${r.error}`);
    if (r.deleted) return send(`List ${r.deleted} deleted.`);
    return send(`${action === "create" ? "Created" : "Updated"}:\n${show(r.list)}${r.not_found ? `\n\nNot in the list: ${r.not_found.join(", ")}` : ""}`);
  }

  async taskList(m, { all = false } = {}) {
    if (!this.runner) return this.reply(m, "Scheduled tasks are not available on this server.");
    if (all) {
      const every = this.store.listTasks();
      if (!every.length) return this.reply(m, "No tasks anywhere yet.");
      const byChat = new Map();
      for (const t of every) byChat.set(String(t.chatId), [...(byChat.get(String(t.chatId)) || []), t]);
      const body = [...byChat].map(([c, ts]) => `Chat ${c}:\n${ts.map((t) => this.taskLine(t)).join("\n")}`).join("\n\n");
      return this.tg.sendPlain(m.chat.id, `All tasks (${every.length}, ${every.filter((t) => t.enabled).length} active):\n\n${body}\n\nManage a task from its own chat.`, { reply_to_message_id: m.message_id }).catch(() => {});
    }
    const list = this.store.listTasks(m.chat.id);
    if (!list.length) return this.reply(m, "No tasks in this chat yet. Tell me what to watch and how often, or use:\n/task add daily 08:30 | India macro news: RBI, inflation, GDP, rupee");
    return this.tg.sendPlain(m.chat.id, `Tasks in this chat:\n\n${list.map((t) => this.taskLine(t)).join("\n\n")}`, { reply_to_message_id: m.message_id }).catch(() => {});
  }

  async taskCommand(m, rest, access) {
    if (!this.runner) return this.reply(m, "Scheduled tasks are not available on this server.");
    const chatId = String(m.chat.id), userId = String(m.from.id);
    const [sub, ...words] = rest.split(/\s+/);
    const action = (sub || "").toLowerCase();
    const own = (t) => access.admin || String(t.createdBy) === userId;
    const getOwned = (idText) => {
      const t = this.store.getTask(String(idText || "").replace(/^#/, ""));
      if (!t || String(t.chatId) !== chatId) return { error: `There is no task #${idText || "?"} in this chat. See /tasks.` };
      if (!own(t)) return { error: `Only the person who created task #${t.id} or an admin can change it.` };
      return { t };
    };
    if (!action || action === "help") return this.reply(m, "Usage:\n/task add <schedule> [alerts] | <what to watch>\n/task run|pause|resume|delete|show <n>\n/task schedule <n> <schedule>\n/task edit <n> | <new instruction>\n\n" + schedule.SCHEDULE_HELP);

    if (action === "add") {
      const body = rest.slice(sub.length).trim();
      const bar = body.indexOf("|");
      if (bar < 0) return this.reply(m, "Use: /task add <schedule> [alerts] | <what to watch>\nExample: /task add weekdays 09:15 alerts | Big news on TCS, Infosys, HCL, Wipro");
      let sched = body.slice(0, bar).trim();
      let mode = "digest";
      if (/\balerts?$/i.test(sched)) { mode = "alerts"; sched = sched.replace(/\s*\balerts?$/i, ""); }
      if (/\bdigest$/i.test(sched)) sched = sched.replace(/\s*\bdigest$/i, "");
      // Monitoring rarely needs project code: by default a task gets only the live market data (if this chat reads it).
      const projects = this.selectionOf(chatId).filter((id) => id === "heatmap-dashboard");
      const { mode: engine, text: instr } = parseEngines(body.slice(bar + 1));
      const r = this.runner.create({ chatId, createdBy: userId, createdByLabel: label(m.from), instruction: instr, scheduleText: sched, mode, projects, engine });
      if (r.error) return this.reply(m, `Couldn't create the task: ${r.error}`);
      return this.reply(m, `Task #${r.task.id} created: ${r.task.title}\nRuns ${r.task.schedule}${mode === "alerts" ? " (alerts: material events only)" : ""}. First run: ${schedule.fmtIst(r.task.nextRunAt)}.\nSources: web, news${this.researchTool ? ", Grok research" : ""}${r.task.projects.includes("heatmap-dashboard") && this.liveOn ? ", live market data" : ""}. (To let it read project code too, ask me in plain words.)\nUse /task run ${r.task.id} to try it now.`);
    }

    const id = words[0];
    if (action === "show") {
      const t = this.store.getTask(String(id || "").replace(/^#/, ""));
      if (!t || String(t.chatId) !== chatId) return this.reply(m, `There is no task #${id || "?"} in this chat.`);
      return this.reply(m, `${this.taskLine(t)}\n\nCreated by ${t.createdByLabel || t.createdBy}. Runs so far: ${t.runs || 0}. Items remembered: ${(t.seen || []).length}.\nProjects: ${t.projects.length ? t.projects.join(", ") : "none"}.\n\nInstruction:\n${t.instruction}`);
    }
    const g = getOwned(id);
    if (g.error) return this.reply(m, g.error);
    const t = g.t;
    switch (action) {
      case "run":
        await this.reply(m, `Running task #${t.id} now. The update will be posted here.`);
        this.runner.run(t.id, { manual: true });
        return undefined;
      case "pause": this.runner.setEnabled(t.id, false); return this.reply(m, `Task #${t.id} paused.`);
      case "resume": { const r = this.runner.setEnabled(t.id, true); return this.reply(m, `Task #${t.id} resumed. Next run: ${schedule.fmtIst(r.task.nextRunAt)}.`); }
      case "delete": this.store.deleteTask(t.id); return this.reply(m, `Task #${t.id} deleted.`);
      case "schedule": {
        const r = this.runner.reschedule(t.id, words.slice(1).join(" "));
        return this.reply(m, r.error ? `Couldn't change the schedule: ${r.error}` : `Task #${t.id} now runs ${r.task.schedule}. Next run: ${schedule.fmtIst(r.task.nextRunAt)}.`);
      }
      case "edit": {
        const bar = rest.indexOf("|");
        const text = bar >= 0 ? rest.slice(bar + 1).trim() : "";
        if (text.length < 8) return this.reply(m, `Use: /task edit ${t.id} | <new instruction>`);
        this.store.updateTask(t.id, { instruction: text.slice(0, 3000) });
        return this.reply(m, `Task #${t.id} updated.`);
      }
      default:
        return this.reply(m, "Unknown /task action. Send /task help.");
    }
  }

  async refresh(m, which) {
    const ids = which ? [which.toLowerCase()] : IDS;
    if (ids.some((i) => !byId.has(i))) return this.reply(m, `Unknown project. Use one of: ${IDS.join(", ")}`);
    await this.reply(m, "Refreshing repo snapshots…");
    const out = [];
    for (const id of ids) {
      try { const s = await this.snapshots.refresh(id); out.push(`• ${id}: ${s.sha.slice(0, 12)}, ${s.files.size} files`); }
      catch (e) { out.push(`• ${id}: failed (${String(e.message).slice(0, 120)})`); }
    }
    return this.tg.sendPlain(m.chat.id, out.join("\n")).catch(() => {});
  }

  // ---------------------------------------------------------------- projects
  selectionOf(chatId) {
    const v = this.store.projectsFor(chatId);
    return v === "all" ? [...IDS] : v.filter((id) => byId.has(id));
  }

  projectsView(chatId) {
    const sel = this.selectionOf(chatId);
    const all = sel.length === IDS.length;
    const text = `<b>Projects I may read</b>\n${all ? "All of them." : sel.length ? sel.map((id) => byId.get(id).name).join(", ") : "None: general questions only."}\n\nTap to switch. Changes apply to this chat.`;
    const rows = [];
    for (let i = 0; i < PROJECTS.length; i += 2) {
      rows.push(PROJECTS.slice(i, i + 2).map((p) => ({ text: `${sel.includes(p.id) ? "✅" : "⬜"} ${p.name}`, callback_data: `p:${p.id}` })));
    }
    rows.push([{ text: "All", callback_data: "p:all" }, { text: "None", callback_data: "p:none" }, { text: "Done", callback_data: "p:done" }]);
    return { text, markup: { inline_keyboard: rows } };
  }

  async showProjects(chatId) {
    const v = this.projectsView(chatId);
    return this.tg.sendMessage(chatId, v.text, { reply_markup: v.markup });
  }

  async onCallback(cq) {
    const chat = cq.message && cq.message.chat;
    if (!chat) return this.tg.answerCallback(cq.id);
    const access = check(this.cfg, { chat, from: cq.from });
    if (!access.ok) return this.tg.answerCallback(cq.id, "Not allowed");
    const data = String(cq.data || "");
    if (data.startsWith("m:")) {
      await this.tg.answerCallback(cq.id);
      const m = { chat, from: cq.from, message_id: cq.message.message_id };
      return this.menuAction(m, data.slice(2), access);
    }
    if (data.startsWith("t:")) {
      const [, action, id] = data.split(":");
      if (!this.runner) return this.tg.answerCallback(cq.id);
      return this.onTaskButton(cq, chat, access, action, id);
    }
    if (data.startsWith("w:")) {
      const [, action, id] = data.split(":");
      return this.onChangeButton(cq, chat, action, id);
    }
    if (!data.startsWith("p:")) return this.tg.answerCallback(cq.id);
    const arg = data.slice(2);
    if (arg === "done") {
      await this.tg.answerCallback(cq.id, "Saved");
      return this.tg.editKeyboard(chat.id, cq.message.message_id, { inline_keyboard: [] });
    }
    const cur = new Set(this.selectionOf(chat.id));
    if (arg === "all") this.store.setProjects(chat.id, "all");
    else if (arg === "none") this.store.setProjects(chat.id, []);
    else if (byId.has(arg)) { cur.has(arg) ? cur.delete(arg) : cur.add(arg); const next = IDS.filter((id) => cur.has(id)); this.store.setProjects(chat.id, next.length === IDS.length ? "all" : next); }
    else return this.tg.answerCallback(cq.id, "Unknown project");
    await this.tg.answerCallback(cq.id);
    const v = this.projectsView(chat.id);
    await this.tg.call("editMessageText", { chat_id: chat.id, message_id: cq.message.message_id, text: v.text, parse_mode: "HTML", reply_markup: v.markup }).catch(() => {});
  }

  // ---------------------------------------------------------------- questions
  async reply(m, text) {
    return this.tg.sendPlain(m.chat.id, text, { reply_to_message_id: m.message_id }).catch(() => {});
  }

  async readAttachments(m, list) {
    if (list.length > MAX_FILES) throw new HttpError(400, `At most ${MAX_FILES} files per message.`);
    const out = [];
    for (const d of list) {
      const name = String(d.file_name || "file").replace(/[\\/\x00-\x1f]/g, "_").slice(0, 120);
      if (!kindOf(name, d.mime_type)) throw new HttpError(400, `I can't read "${name}". Send it as PDF, Excel (.xlsx), Word (.docx), PowerPoint (.pptx), CSV or a text file. Old .xls/.doc/.ppt files: open them and save in the new format first.`);
      if (d.file_size && d.file_size > MAX_FILE_BYTES) throw new HttpError(413, `"${name}" is bigger than 10 MB. Please send a smaller file, or split it.`);
      const buf = await this.tg.download(d.file_id, MAX_FILE_BYTES);
      try { out.push(...await extractAll({ name, mime: d.mime_type || "", buf })); }
      catch (e) { throw new HttpError(400, String(e.message || e).slice(0, 300)); }
    }
    return out;
  }

  /** Files stay available for follow-up questions in the same chat for FILE_MEMORY_HOURS (RAM only). */
  rememberFiles(chatId, docs) {
    const key = String(chatId), now = Date.now(), ttl = this.cfg.fileMemoryHours * 3600e3;
    const keep = (this.files.get(key) || []).filter((f) => now - f.at < ttl && !docs.some((d) => d.name === f.doc.name));
    const next = [...keep, ...docs.map((doc) => ({ doc, at: now }))].slice(-this.cfg.fileMemoryMax);
    this.files.set(key, next);
    return next.map((f) => f.doc);
  }
  recentFiles(chatId) {
    const ttl = this.cfg.fileMemoryHours * 3600e3, now = Date.now();
    return (this.files.get(String(chatId)) || []).filter((f) => now - f.at < ttl).map((f) => f.doc);
  }

  /** Runs one question through the agent and sends the answer. */
  async ask(m, { text: rawText, attachments, access, projects, scheduled = false }) {
    const chatId = m.chat.id;
    const { mode: engine, text: parsedText } = parseEngines(rawText);
    const text = parsedText || (rawText && engine !== "default" ? "Hello" : rawText);
    const userLabel = scheduled ? "the scheduled morning brief" : label(m.from);
    const userId = scheduled ? "brief" : String(m.from.id);
    const sysMode = scheduled; // scheduled runs keep no conversation history
    let attached;
    try {
      const fresh = attachments.length ? await this.readAttachments(m, attachments) : [];
      attached = scheduled || this.cfg.fileMemoryHours <= 0 ? fresh : fresh.length ? this.rememberFiles(chatId, fresh) : this.recentFiles(chatId);
    } catch (e) {
      return this.reply(m, e.message || "Could not read that file.");
    }
    const selected = projects || this.selectionOf(chatId);

    const typing = setInterval(() => this.tg.typing(chatId), 4000);
    this.tg.typing(chatId);
    // Research can take a minute: after a few seconds say so, and remove the note when the answer arrives.
    let waitNote = null;
    const waitTimer = this.cfg.waitNoteMs > 0 && setTimeout(() => {
      waitNote = this.tg.sendPlain(chatId, "🔎 Looking into it… this can take up to a minute.").then((r) => r && r.message_id).catch(() => null);
    }, this.cfg.waitNoteMs);
    const started = Date.now();
    // Team member = Telegram linked in BusyBee. Gives the project databases and BusyBee actions.
    let member = null;
    if (!scheduled && this.team && m.from) {
      member = await this.team.member(m.from.id);
      if (member) member = { ...member, telegramId: String(m.from.id) };
    }
    const busybeeApi = this.cfg.busybeeAppUrl && this.cfg.busybeeAgentSecret ? { url: this.cfg.busybeeAppUrl, secret: this.cfg.busybeeAgentSecret } : null;
    const ctx = {
      projectDbs: this.projectDbs, member, openData: this.cfg.projectDataAccess === "everyone", busybeeApi,
      pending: scheduled ? null : this.pending, changeQueue: [],
      recordChange: (e) => { this.store.addAudit(e); this.log(`[change] ${e.by || "?"} ${e.action} ${e.project}.${e.table}: ${e.summary}`); },
      store: this.snapshots, live: this.live, selected, githubToken: this.cfg.githubToken, // repo tools read ctx.store = the snapshot store
      attachments: attached, fetch, projectsUsed: new Set(), usage: { in: 0, out: 0 },
      lists: this.store, secUserAgent: this.cfg.secUserAgent || undefined,
      user: { id: userId, label: userLabel },
      audit: async ({ tool, ok, ms }) => this.log(`[tool] user=${userId} tool=${tool} ok=${ok} ms=${ms}`),
      task: this.runner && !scheduled ? { runner: this.runner, chatId: String(chatId), userId, userLabel, admin: !!access.admin, chatProjects: selected, engine } : null,
    };
    try {
      const hist = sysMode ? [] : (this.history.get(String(chatId)) || []);
      const out = await runWithEngines({
        mode: engine, engines: this.engines, researchTool: this.researchTool,
        buildTools: (research) => buildTools({ selected, user: { isAdmin: !!access.admin }, attached, liveOn: this.liveOn, researchTool: research, taskTools: !!ctx.task, projectDbs: this.projectDbs, busybeeActions: !!busybeeApi, writeActions: !scheduled }),
        buildSystem: (toolNames) => buildSystemPrompt({ user: { label: userLabel }, member, selected, attached, toolNames, telegram: true }),
        ctx, history: hist, message: text,
        maxSteps: this.cfg.maxSteps, deadline: started + this.cfg.requestDeadlineMs,
        checkBudget: () => this.store.check(userId, this.cfg, this.now()),
      });
      // Say which AI answered only when the person picked one with a tag.
      const by = engine === "default" ? "" : out.partial
        ? `\n\n🤖 ${ENGINE_LABEL[out.engines[0]]} only (the other one failed this time)`
        : `\n\n🤖 ${ENGINE_LABEL[engine]}`;
      const answer = withProjectsFooter(out.answer, ctx.projectsUsed, selected) + by;
      if (!sysMode) this.remember(chatId, text + (attached.length ? `\n[attached: ${attached.map((d) => d.name).join(", ")}]` : ""), out.answer);
      for (const html of toTelegramMessages(answer)) {
        await this.tg.sendMessage(chatId, html, { reply_to_message_id: m.message_id }).catch(async () => this.tg.sendPlain(chatId, html.replace(/<[^>]+>/g, "")));
      }
      // Changes proposed during this answer: ask for a tap before anything is written.
      for (const id of ctx.changeQueue) await this.askToConfirm(chatId, id, m.message_id);
      this.log(`[answer] user=${userId} projects=${[...ctx.projectsUsed].join(",") || "-"} steps=${out.steps.length} ms=${Date.now() - started}`);
    } catch (e) {
      const msg = e instanceof BudgetError || e instanceof HttpError || e.userFacing ? e.message : "Sorry, I couldn't finish that one. Please try again, or ask in a simpler or shorter way.";
      if (!(e instanceof BudgetError || e instanceof HttpError || e.userFacing)) this.log(`[answer] error: ${String(e.stack || e).slice(0, 400)}`);
      await this.tg.sendPlain(chatId, msg, { reply_to_message_id: m.message_id }).catch(() => {});
    } finally {
      clearInterval(typing);
      clearTimeout(waitTimer);
      if (waitNote) waitNote.then((id) => id && this.tg.deleteMessage(chatId, id));
      if (ctx.usage.in || ctx.usage.out) this.store.record(userId, ctx.usage.in, ctx.usage.out, this.now());
    }
  }

  remember(chatId, question, answer) {
    const key = String(chatId);
    const h = this.history.get(key) || [];
    h.push({ role: "user", content: question.slice(0, 8000) }, { role: "assistant", content: String(answer).slice(0, 8000) });
    while (h.length > this.cfg.historyTurns * 2) h.splice(0, 2);
    this.history.set(key, h);
  }

}

module.exports = { Bot, BRIEF_PROMPT, HELP, ADVANCED_HELP, MENU, esc };
