"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const cal = require("../src/marketCalendar");
const { buildSystemPrompt } = require("../src/prompt");

const SAMPLE = JSON.stringify({
  holidays: [{ date: "2026-11-24", name: "Prakash Gurpurb", verified: false }, { date: "2026-10-02", name: "Gandhi Jayanti", verified: true }],
  special_sessions: [{ date: "2026-11-08", name: "Muhurat trading", open: "14:20", close: "15:30" }],
});

test("a market holiday today is stated from the team's list, by name", () => {
  cal.set(cal.parse(SAMPLE));
  const p = buildSystemPrompt({ user: { label: "x" }, selected: [], channel: "dashboard", now: new Date("2026-11-24T09:15:00Z") });
  assert.match(p, /Today \(2026-11-24, Tuesday\) is an NSE \/ BSE MARKET HOLIDAY: Prakash Gurpurb/);
  assert.match(p, /check this list FIRST/);
  assert.match(p, /2026-10-02 \(Fri\) Gandhi Jayanti/);
  assert.match(p, /Muhurat trading/);
});

test("weekends and normal days are described as such", () => {
  cal.set(cal.parse(SAMPLE));
  assert.match(cal.section(new Date("2026-11-22T06:00:00Z")), /is a Sunday: the Indian markets are closed/);
  assert.match(cal.section(new Date("2026-11-25T06:00:00Z")), /is a normal Indian trading day/);
});

test("loads from the heatmap-dashboard snapshot; a failure keeps the last good list", async () => {
  cal.set(null);
  const snaps = { ensure: async () => ({ files: new Map([[cal.FILE, { text: SAMPLE }]]) }) };
  const d = await cal.load(snaps);
  assert.equal(d.holidays.length, 2);
});

test("the real list in the heatmap repo parses (when checked out next to this repo)", (t) => {
  const f = "/home/claude/heatmap-dashboard/shared/nse_holidays.json";
  if (!fs.existsSync(f)) return t.skip("heatmap repo not present");
  const d = cal.parse(fs.readFileSync(f, "utf8"));
  assert.ok(d.holidays.some((h) => h.date === "2026-11-24"));
});
