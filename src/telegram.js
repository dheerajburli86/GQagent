"use strict";
// Minimal Telegram Bot API client over HTTPS long polling. No webhook, so the
// service needs no public URL. Only one instance may poll a bot token at a
// time (Telegram answers a second poller with 409), so run ONE replica.

const DEFAULT_API = "https://api.telegram.org";

class TelegramClient {
  constructor({ token, apiBase = DEFAULT_API, fetchImpl = fetch, log = console.log }) {
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
    this.token = token;
    this.api = String(apiBase).replace(/\/$/, "");
    this.fetch = fetchImpl;
    this.log = log;
  }

  /** Redacts the token from anything that might be logged. */
  scrub(s) { return String(s).split(this.token).join("<token>"); }

  async call(method, params = {}, { timeoutMs = 20000, retries = 2 } = {}) {
    for (let attempt = 0; ; attempt++) {
      let res, j;
      try {
        res = await this.fetch(`${this.api}/bot${this.token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(timeoutMs),
        });
        j = await res.json().catch(() => ({}));
      } catch (e) {
        if (attempt < retries) { await sleep(1000 * (attempt + 1)); continue; }
        throw new Error(this.scrub(`${method} failed: ${e.message}`));
      }
      if (j.ok) return j.result;
      const retryAfter = j.parameters && j.parameters.retry_after;
      if (res.status === 429 && attempt < retries + 3) { await sleep((retryAfter || 2) * 1000); continue; }
      const err = new Error(this.scrub(`${method}: ${j.description || res.status}`));
      err.code = j.error_code || res.status;
      throw err;
    }
  }

  getMe() { return this.call("getMe"); }
  deleteWebhook() { return this.call("deleteWebhook", { drop_pending_updates: false }); }
  getUpdates(offset, timeout = 40) {
    return this.call("getUpdates", { offset, timeout, allowed_updates: ["message", "callback_query"] }, { timeoutMs: (timeout + 15) * 1000, retries: 0 });
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  }
  /** Sends plain text (used for errors and notices, so no markup can break). */
  sendPlain(chatId, text, extra = {}) {
    return this.call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...extra });
  }
  deleteMessage(chatId, messageId) { return this.call("deleteMessage", { chat_id: chatId, message_id: messageId }, { retries: 0 }).catch(() => {}); }
  typing(chatId) { return this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}); }
  answerCallback(id, text = "") { return this.call("answerCallbackQuery", { callback_query_id: id, text }).catch(() => {}); }
  editKeyboard(chatId, messageId, markup) {
    return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: markup }).catch(() => {});
  }

  /** Downloads a file a user sent (Bot API limit: 20 MB). Returns a Buffer. */
  async download(fileId, maxBytes = 20 * 1024 * 1024) {
    const f = await this.call("getFile", { file_id: fileId });
    if (f.file_size && f.file_size > maxBytes) throw new Error("file is larger than 20 MB");
    const res = await this.fetch(`${this.api}/file/bot${this.token}/${f.file_path}`, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error("file is larger than 20 MB");
    return buf;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Long-polls for updates forever, calling handle(update) for each, in order.
 * Stops when `signal` aborts. Backs off on network errors and on 409 (another
 * instance is polling).
 */
async function poll(client, handle, { signal, onError = (e) => client.log(`[telegram] ${e.message}`) } = {}) {
  let offset = 0;
  let backoff = 1000;
  while (!(signal && signal.aborted)) {
    let updates;
    try {
      updates = await client.getUpdates(offset, 40);
      backoff = 1000;
    } catch (e) {
      if (e.code === 409) onError(new Error("another instance is polling this bot; stop the other one (one replica only)"));
      else onError(e);
      await sleep(e.code === 409 ? 10000 : backoff);
      backoff = Math.min(backoff * 2, 60000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      try { await handle(u); } catch (e) { onError(new Error(`handler: ${e.message}`)); }
    }
  }
}

module.exports = { TelegramClient, poll, sleep };
