"use strict";
// The team's NSE / BSE holiday list (heatmap-dashboard: shared/nse_holidays.json, the ONE calendar the heatmap,
// india-live and the pipelines all read). Loaded from the repo snapshot and put into every system prompt, so a
// question like "why is there no price for 24 Nov" is answered from OUR list ("market holiday: Prakash Gurpurb")
// instead of a guess about market hours.
const FILE = "shared/nse_holidays.json";
const TTL_MS = 6 * 3600e3;

let cache = { at: 0, data: null, error: null };
let loading = null;

const istDate = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
const weekday = (iso) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(`${iso}T00:00:00Z`).getUTCDay()];

function parse(text) {
  const j = JSON.parse(text);
  const holidays = (Array.isArray(j) ? j : j.holidays || [])
    .filter((h) => h && /^\d{4}-\d{2}-\d{2}$/.test(h.date))
    .map((h) => ({ date: h.date, name: String(h.name || "holiday"), verified: h.verified !== false }));
  const special = (j.special_sessions || []).filter((s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s.date))
    .map((s) => ({ date: s.date, name: String(s.name || "special session"), open: s.open || s.start || null, close: s.close || s.end || null }));
  holidays.sort((a, b) => a.date.localeCompare(b.date));
  return { holidays, special };
}

/** Loads (at most every 6 h) from the heatmap-dashboard snapshot. Never throws: a failure keeps the last good list. */
async function load(snapshots) {
  if (!snapshots || typeof snapshots.ensure !== "function") return cache.data;
  if (cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  if (!loading) {
    loading = (async () => {
      try {
        const snap = await snapshots.ensure("heatmap-dashboard");
        const f = snap && snap.files && snap.files.get(FILE);
        if (!f || !f.text) throw new Error(`${FILE} not in the heatmap-dashboard snapshot`);
        cache = { at: Date.now(), data: parse(f.text), error: null };
      } catch (e) { cache = { ...cache, at: Date.now(), error: String(e.message || e).slice(0, 200) }; }
      finally { loading = null; }
      return cache.data;
    })();
  }
  return loading;
}

function set(data) { cache = { at: Date.now(), data, error: null }; }

/** The prompt section, or "" when the list is not loaded. `now` is injectable for tests. */
function section(now = new Date()) {
  const data = cache.data;
  if (!data) return "";
  const today = istDate(now);
  const year = Number(today.slice(0, 4));
  const hol = new Map(data.holidays.map((h) => [h.date, h]));
  const sp = new Map(data.special.map((s) => [s.date, s]));
  const wd = weekday(today);
  const todayLine = hol.has(today)
    ? `Today (${today}, ${wd}) is an NSE / BSE MARKET HOLIDAY: ${hol.get(today).name}. The Indian markets are closed all day, so there is no price, candle or return for ${today}, and there will not be one.`
    : sp.has(today)
      ? `Today (${today}, ${wd}) is a special trading session: ${sp.get(today).name}${sp.get(today).open ? ` (${sp.get(today).open}-${sp.get(today).close} IST)` : ""}.`
      : wd === "Saturday" || wd === "Sunday"
        ? `Today (${today}) is a ${wd}: the Indian markets are closed.`
        : `Today (${today}, ${wd}) is a normal Indian trading day (09:15-15:30 IST); the day's closing prices are stored after the evening refresh.`;
  const fmt = (h) => `${h.date} (${weekday(h.date).slice(0, 3)}) ${h.name}${h.verified ? "" : " [not yet confirmed against the exchange circular]"}`;
  const list = data.holidays.filter((h) => { const y = Number(h.date.slice(0, 4)); return y >= year - 1 && y <= year + 1; });
  const specials = data.special.filter((s) => Number(s.date.slice(0, 4)) >= year - 1);
  return `

Indian market calendar (the team's own holiday list: heatmap-dashboard ${FILE}; the dashboard and the data pipelines use the same list):
${todayLine}
Holidays: ${list.map(fmt).join("; ")}.${specials.length ? `\nSpecial sessions on otherwise-closed days: ${specials.map((s) => `${s.date} ${s.name}`).join("; ")}.` : ""}
Weekends are always closed. When someone asks why a date has no Indian price, candle or return, check this list FIRST: if the date is on it, say it was a market holiday and name it; if it is a weekend, say so; only otherwise talk about market hours, the evening refresh, or a data gap (and then check the data). For US / other markets this list does not apply.`;
}

module.exports = { load, set, section, parse, FILE };
