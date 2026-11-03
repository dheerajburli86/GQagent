"use strict";
// The tool set for ONE question. Built per question because what the model
// may see depends on the projects selected: tools for unselected projects are
// never declared, and the attachments present decide the file tools.
//
// Kinds (none of them writes anything):
//   general  current_time, web_search, web_fetch, calculate, public_data,  no data handle at all
//            company_filings (NSE/BSE announcements, SEC EDGAR), macro_news (by country), watchlists (read the team's lists)
//   files    read_attachment, search_attachment, analyze_table              only when files are attached
//   repo     read_docs, list_files, grep_code, read_file                   in-memory snapshots
//            recent_changes, show_commit                                    GitHub API, GET only
//   live     heatmap market data                                            read-only allowlist, only when configured
//   research web_research (xAI Grok search, sourced)                        only when XAI_API_KEY is set
//   tasks    schedule_task, list_scheduled_tasks, manage_scheduled_task,    live chats only; write the bot's own task list
//            edit_watchlist (admins)                                        and watchlists
const web = require("./web");
const search = require("./search");
const calc = require("./calc");
const publicData = require("./public_data");
const github = require("./github");
const attachments = require("./attachments");
const repo = require("./repo");
const live = require("./live");
const research = require("./research");
const scheduleTools = require("./schedule_tools");
const filings = require("./filings");
const watchlists = require("./watchlists");
const macro = require("./macro");
const { byId } = require("../projects");

const timeTool = {
  name: "current_time",
  description: "Current date and time (IST, UTC, and optionally another IANA time zone). Use it for anything relative to today.",
  // One optional argument: some backends reject a tool whose schema has no properties.
  parameters: { type: "object", properties: { timezone: { type: "string", description: "optional IANA zone, e.g. America/New_York" } } },
  async run(a = {}) {
    const d = new Date();
    const fmt = (tz) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "full", timeStyle: "long" }).format(d);
    const out = { utc: d.toISOString(), ist: fmt("Asia/Kolkata") };
    if (a.timezone) { try { out[a.timezone] = fmt(String(a.timezone)); } catch { out.timezone_error = "unknown time zone"; } }
    return out;
  },
};

const NO_DB = (t) => ({ ...t, run: (a, ctx) => t.run(a, { ...ctx, sb: null }) });

/** buildTools({selected, user, attached, liveOn}). user.isAdmin unlocks adminOnly tools (none today). */
/** taskTools: true only in a live conversation where a TaskRunner exists (never in scheduled runs). */
function buildTools({ selected, user = {}, attached = [], liveOn = false, researchTool = null, taskTools = false }) {
  const visible = (t) => !t.adminOnly || user.isAdmin;
  const general = [timeTool, ...search.makeTools(), ...web.makeTools(), calc.tool, publicData.tool, filings.tool, macro.tool, watchlists.readTool]
    .filter(visible).map((t) => ({ ...NO_DB(t), kind: "general" }));
  const files = attachments.makeTools(attached).map((t) => ({ ...NO_DB(t), kind: "files" }));
  const repoTools = [...repo.makeTools(selected), ...github.makeTools(selected)].map((t) => ({ ...NO_DB(t), kind: "repo" }));
  const liveTools = liveOn ? live.makeTools(selected, { projectsById: byId }) : [];
  const researchTools = researchTool ? [{ ...NO_DB(researchTool), kind: "general" }] : [];
  const tasks = taskTools ? [...scheduleTools.makeTools(), ...(user.isAdmin ? [watchlists.editTool] : [])].map((t) => ({ ...NO_DB(t), kind: "tasks" })) : [];
  return [...general, ...researchTools, ...files, ...repoTools, ...liveTools, ...tasks];
}

module.exports = { buildTools, timeTool, research };
