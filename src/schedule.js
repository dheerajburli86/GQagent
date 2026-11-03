"use strict";
// Task schedules, always in India time (IST, UTC+05:30, no daylight saving).
//
// Accepted forms (case-insensitive):
//   every 30m | every 45 minutes | every 2h | every 3 hours | hourly | every hour
//   daily 08:30 | every day 9:00, 15:30 | daily at 8:30am
//   weekdays 09:15 | weekends 10:00
//   mon,wed,fri 09:00 | weekly mon 09:00 | monday 18:30 | tue thu 7pm
// Parsed form: { kind: "interval", minutes } or { kind: "times", days: [0..6], times: [minuteOfDay...] }

const IST_MS = 5.5 * 3600e3;
const DAY_MS = 864e5;
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayIndex(word) {
  const w = word.toLowerCase().slice(0, 3);
  const i = DAYS.indexOf(w);
  return i;
}

/** "8:30", "08:30", "8.30", "8am", "8:30pm", "20:00" -> minute of day, or null. */
function parseTime(s) {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i.exec(String(s).trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (!m[2] && !m[3]) return null; // a bare number is ambiguous
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3].toLowerCase() === "pm" && h !== 12) h += 12;
    if (m[3].toLowerCase() === "am" && h === 12) h = 0;
  }
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Parses a schedule. Returns { spec } or { error }. minMinutes is the shortest
 * interval allowed (cost and politeness to the sources).
 */
function parse(input, { minMinutes = 15 } = {}) {
  const s = String(input || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*ist$/, "");
  if (!s) return { error: "schedule is empty" };

  if (s === "hourly" || s === "every hour") return { spec: { kind: "interval", minutes: 60 } };
  let m = /^every (\d+(?:\.\d+)?) ?(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    const minutes = Math.round(/^h/.test(m[2]) ? n * 60 : n);
    if (!(minutes >= minMinutes)) return { error: `the shortest interval is every ${minMinutes} minutes` };
    if (minutes > 7 * 24 * 60) return { error: "the longest interval is 7 days; use a weekly schedule like 'mon 09:00'" };
    return { spec: { kind: "interval", minutes } };
  }

  // day part, then times
  m = /^(?:(?:every ?day|daily|weekdays|weekends|weekly)\b ?)?((?:(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*(?:[ ,/&]+|\band\b ?)*)*)(?:at )?(.+)$/.exec(s);
  if (!m) return { error: SCHEDULE_HELP };
  const head = /^(every ?day|daily|weekdays|weekends|weekly)\b/.exec(s);
  let days;
  const dayWords = (m[1] || "").split(/[ ,/&]+|\band\b/).filter(Boolean);
  if (dayWords.length) {
    days = [...new Set(dayWords.map(dayIndex))];
    if (days.some((d) => d < 0)) return { error: "unknown day name" };
  } else if (head && head[1] === "weekdays") days = [1, 2, 3, 4, 5];
  else if (head && head[1] === "weekends") days = [0, 6];
  else if (head && head[1] === "weekly") return { error: "say which day, e.g. 'weekly mon 09:00'" };
  else if (head) days = [0, 1, 2, 3, 4, 5, 6];
  else return { error: SCHEDULE_HELP };

  const times = String(m[2]).split(/\s*(?:,|and|&)\s*/).filter(Boolean).map(parseTime);
  if (!times.length || times.some((t) => t === null)) return { error: "times must look like 08:30, 9:00 or 7pm (IST)" };
  return { spec: { kind: "times", days: days.sort(), times: [...new Set(times)].sort((a, b) => a - b) } };
}

const pad = (n) => String(n).padStart(2, "0");
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

function describe(spec) {
  if (spec.kind === "interval") {
    const m = spec.minutes;
    if (m % 60 === 0) return m === 60 ? "every hour" : `every ${m / 60} hours`;
    return `every ${m} minutes`;
  }
  const t = spec.times.map(hhmm).join(", ");
  const d = spec.days;
  const dayText = d.length === 7 ? "daily" : d.join() === "1,2,3,4,5" ? "weekdays" : d.join() === "0,6" ? "weekends" : d.map((x) => DAY_NAMES[x]).join(", ");
  return `${dayText} at ${t} IST`;
}

/**
 * The next run strictly after `from` (a Date). For intervals, `last` (the
 * previous run, or null) anchors the cadence; a task that never ran is due now.
 */
function nextRun(spec, from, last = null) {
  const now = from.getTime();
  if (spec.kind === "interval") {
    if (!last) return new Date(now);
    const n = last.getTime() + spec.minutes * 60e3;
    return new Date(n > now ? n : now + spec.minutes * 60e3);
  }
  const ist = new Date(now + IST_MS);
  const baseIstMidnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  for (let off = 0; off <= 8; off++) {
    const dayStart = baseIstMidnight + off * DAY_MS;
    const wd = new Date(dayStart).getUTCDay();
    if (!spec.days.includes(wd)) continue;
    for (const t of spec.times) {
      const utc = dayStart + t * 60e3 - IST_MS;
      if (utc > now) return new Date(utc);
    }
  }
  throw new Error("no next run found");
}

/** How far back a first run should look. */
function lookback(spec) {
  if (spec.kind === "interval") return spec.minutes >= 24 * 60 ? `${Math.round(spec.minutes / 1440)} days` : "24 hours";
  return spec.days.length >= 5 ? "24 hours" : "7 days";
}

function fmtIst(d) {
  if (!d) return "never";
  const x = new Date(new Date(d).getTime() + IST_MS);
  return `${pad(x.getUTCDate())} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][x.getUTCMonth()]} ${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())} IST`;
}

const SCHEDULE_HELP = "use a schedule like: every 30m, every 2h, hourly, daily 08:30, daily 9:00, 15:30, weekdays 09:15, weekends 10:00, mon,thu 18:00 (times are IST)";

module.exports = { parse, describe, nextRun, lookback, fmtIst, parseTime, SCHEDULE_HELP };
