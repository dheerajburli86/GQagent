"use strict";
// Who may talk to the bot. OPEN BY DEFAULT: anyone who finds the bot and taps
// /start can use it, in a direct chat or in any group it is added to.
//
// The three lists are optional switches for later, all empty by default:
//   TELEGRAM_ALLOWED_USER_IDS   set it and only those people may use the bot
//   TELEGRAM_ALLOWED_GROUP_IDS  set it and only those groups are answered
//   TELEGRAM_ADMIN_USER_IDS     set it and only those people get admin powers
//                               (empty: everyone has them)
// Identity is the Telegram user id, which Telegram proves on every message.

/** Decides whether a message may be handled. Returns {ok:true, admin} or {ok:false, reason}. */
function check(cfg, { chat, from }) {
  if (!from || from.is_bot) return { ok: false, reason: "bot-or-unknown" };
  const uid = String(from.id);
  const open = (set, id) => set.size === 0 || set.has(id);
  if (!open(cfg.allowedUserIds, uid)) return { ok: false, reason: "not-allowed", userId: uid };
  const admin = open(cfg.adminUserIds, uid);
  if (chat.type === "private") return { ok: true, admin };
  if (chat.type === "group" || chat.type === "supergroup") {
    if (!open(cfg.allowedGroupIds, String(chat.id))) return { ok: false, reason: "group-not-allowed", silent: true };
    return { ok: true, admin };
  }
  return { ok: false, reason: "channel-or-other", silent: true };
}

/** The name the model should use for this person (shown in the system prompt). */
function label(from) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  return name ? `${name}${from.username ? ` (@${from.username})` : ""}` : from.username ? `@${from.username}` : `Telegram user ${from.id}`;
}

/** Whether scheduled updates may still post to this chat (same rules as messages). */
function chatAllowed(cfg, chatId) {
  const id = String(chatId);
  const isGroup = id.startsWith("-");
  if (isGroup) return cfg.allowedGroupIds.size === 0 || cfg.allowedGroupIds.has(id);
  return cfg.allowedUserIds.size === 0 || cfg.allowedUserIds.has(id);
}

module.exports = { check, label, chatAllowed };
