"use strict";
// Converts the model's Markdown into the HTML subset Telegram accepts
// (b, i, code, pre, a) and splits long answers under Telegram's 4096-character
// limit without breaking code blocks.

const LIMIT = 3000; // raw characters per message; escaping and tags stay under 4096

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Inline Markdown -> Telegram HTML. Code spans are protected first so nothing inside them is re-styled. */
function inline(text) {
  const spans = [];
  let t = String(text).replace(/`([^`\n]{1,300})`/g, (_, c) => { spans.push(c); return `\u0000${spans.length - 1}\u0000`; });
  t = esc(t);
  // the text is already escaped, so the URL needs only quote-protection
  t = t.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,500})\)/g, (_, label, url) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`);
  t = t.replace(/\*\*([^*\n]{1,400})\*\*/g, "<b>$1</b>");
  t = t.replace(/(^|[\s(])\*([^*\n]{1,300})\*(?=[\s).,:;!?]|$)/g, "$1<i>$2</i>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(spans[+i])}</code>`);
}

/** Markdown answer -> Telegram HTML (one message's worth). */
function toHtml(md) {
  const lines = String(md).replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre>${esc(body.join("\n"))}</pre>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
        i++;
      }
      const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => (r[c] || "").length)));
      out.push(`<pre>${esc(rows.map((r) => r.map((c, k) => (c || "").padEnd(widths[k])).join("  ").trimEnd()).join("\n"))}</pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) { out.push(`<b>${inline(h[2])}</b>`); i++; continue; }
    const bullet = /^(\s*)[-*•]\s+(.*)$/.exec(l);
    if (bullet) { out.push(`${bullet[1] ? "  " : ""}• ${inline(bullet[2])}`); i++; continue; }
    out.push(inline(l));
    i++;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Splits Markdown into chunks of at most LIMIT characters, at line breaks, closing and reopening any code fence that spans a cut. */
function chunk(md, limit = LIMIT) {
  const lines = String(md).replace(/\r/g, "").split("\n");
  const parts = [];
  let cur = "", inFence = false;
  const flush = () => { if (cur.trim()) parts.push(cur.replace(/\n+$/, "")); cur = ""; };
  for (const l of lines) {
    const piece = l + "\n";
    if (cur.length + piece.length > limit && cur.length > 0) {
      if (inFence) { cur += "```\n"; flush(); cur = "```\n"; }
      else flush();
    }
    if (piece.length > limit) { // one enormous line: hard-cut it
      for (let k = 0; k < piece.length; k += limit) { cur += piece.slice(k, k + limit); if (k + limit < piece.length) flush(); }
    } else cur += piece;
    if (/^\s*```/.test(l)) inFence = !inFence;
  }
  if (inFence) cur += "```";
  flush();
  return parts.length ? parts : [""];
}

/** True when every tag Telegram would parse is opened and closed in order. Used by tests and as a last-resort guard. */
function wellFormed(html) {
  const stack = [];
  const re = /<\/?(b|i|code|pre|a)(\s[^>]*)?>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0][1] !== "/") stack.push(m[1]);
    else { if (stack.pop() !== m[1]) return false; }
  }
  return stack.length === 0;
}

/** Full pipeline: Markdown -> [html, html, ...], each well-formed and under the limit. */
function toTelegramMessages(md) {
  const out = [];
  for (const part of chunk(md)) {
    const html = toHtml(part);
    out.push(wellFormed(html) ? html : esc(part)); // never send broken markup
  }
  return out;
}

module.exports = { toHtml, chunk, wellFormed, toTelegramMessages, esc, LIMIT };
