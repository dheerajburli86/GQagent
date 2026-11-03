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
//   data     project_tables, project_query: every configured project database, SELECT only, team members
//   write    project_change (confirm first), dashboard_watchlist: live chats, team members
//   busybee  busybee_create_task, busybee_update_task: through BusyBee's own API, as the asker
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
const database = require("./database");
const busybee = require("./busybee");
const dbwrite = require("./dbwrite");
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
function buildTools({ selected, user = {}, attached = [], liveOn = false, researchTool = null, taskTools = false, projectDbs = null, busybeeActions = false, writeActions = false }) {
  const visible = (t) => !t.adminOnly || user.isAdmin;
  const general = [timeTool, ...search.makeTools(), ...web.makeTools(), calc.tool, publicData.tool, filings.tool, macro.tool, watchlists.readTool]
    .filter(visible).map((t) => ({ ...NO_DB(t), kind: "general" }));
  const files = attachments.makeTools(attached).map((t) => ({ ...NO_DB(t), kind: "files" }));
  const repoTools = [...repo.makeTools(selected), ...github.makeTools(selected)].map((t) => ({ ...NO_DB(t), kind: "repo" }));
  const liveTools = liveOn ? live.makeTools(selected, { projectsById: byId }) : [];
  const researchTools = researchTool ? [{ ...NO_DB(researchTool), kind: "general" }] : [];
  const tasks = taskTools ? [...scheduleTools.makeTools(), ...(user.isAdmin ? [watchlists.editTool] : [])].map((t) => ({ ...NO_DB(t), kind: "tasks" })) : [];
  // Full read access to every configured project database (team members; checked at call time).
  const dataTools = projectDbs ? database.makeTools(selected, projectDbs).map((t) => ({ ...t, kind: "data" })) : [];
  // BusyBee actions: live chats only (never scheduled runs), when BusyBee is selected and configured.
  const bbTools = busybeeActions && taskTools && selected.includes("busybee") ? busybee.tools.map((t) => ({ ...t, kind: "busybee" })) : [];
  // Changes to project data (with Confirm / Cancel) and the asker's own dashboard watchlists: live chats only.
  const writeTools = writeActions ? dbwrite.makeTools(selected, projectDbs).map((t) => ({ ...t, kind: "write" })) : [];
  return [...general, ...researchTools, ...files, ...repoTools, ...liveTools, ...dataTools, ...bbTools, ...writeTools, ...tasks];
}

module.exports = { buildTools, timeTool, research };
