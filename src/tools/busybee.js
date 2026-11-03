"use strict";
// Create and update BusyBee tasks for the person asking. The agent never writes
// BusyBee's database itself: it calls BusyBee's own /api/tasks AS that person
// (lib/agent-auth.ts in BusyBee), so the app's rules decide what is allowed
// (only admins, managers and supervisors may give work to others; the assignee
// can't move their own deadline; ...) and BusyBee sends its usual alerts.
// Names are turned into ids here by reading BusyBee's database.
const { markUsed } = require("./scope");

const STATUS = ["pending", "in_progress", "need_help", "done", "closed"];
const PRIORITY = ["super_high", "high", "medium", "low"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (s) => String(s || "").replace(/[%,()*]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

/** A person on one of the asker's desks, by name, email or id. */
async function findPerson(db, member, who) {
  const q = String(who || "").trim();
  if (!q) return { error: "say who the task is for" };
  if (/^(me|myself|self|mujhe|main)$/i.test(q)) return { id: member.userId, name: member.name || "you" };
  const deskIds = member.desks.map((d) => d.desk_id);
  if (!deskIds.length) return { error: "you aren't on any BusyBee desk yet" };
  const mates = await db.from("desk_members").select("user_id").in("desk_id", deskIds);
  if (mates.error) throw new Error(mates.error.message);
  const ids = [...new Set((mates.data || []).map((m) => m.user_id))];
  if (!ids.length) return { error: "nobody else is on your desks" };
  let rows;
  if (UUID.test(q)) rows = ids.includes(q) ? [{ id: q }] : [];
  else {
    const t = clean(q);
    const r = await db.from("users").select("id, full_name, email").in("id", ids).or(`full_name.ilike.%${t}%,email.ilike.%${t}%`).limit(10);
    if (r.error) throw new Error(r.error.message);
    rows = r.data || [];
    const exact = rows.filter((u) => String(u.full_name || "").toLowerCase() === q.toLowerCase() || String(u.email || "").toLowerCase() === q.toLowerCase());
    if (exact.length === 1) rows = exact;
  }
  if (!rows.length) return { error: `no one called "${q}" is on your BusyBee desks` };
  if (rows.length > 1) return { error: `"${q}" matches more than one person; ask which one`, candidates: rows.map((u) => ({ name: u.full_name, email: u.email })) };
  return { id: rows[0].id, name: rows[0].full_name || rows[0].email };
}

async function findProject(db, member, name) {
  const q = clean(name);
  if (!q) return { id: null };
  if (UUID.test(String(name))) return { id: String(name) };
  const r = await db.from("projects").select("id, name, desk_id").in("desk_id", member.desks.map((d) => d.desk_id)).ilike("name", `%${q}%`).limit(10);
  if (r.error) throw new Error(r.error.message);
  const rows = r.data || [];
  const exact = rows.filter((p) => p.name.toLowerCase() === q.toLowerCase());
  const pick = exact.length === 1 ? exact : rows;
  if (!pick.length) return { error: `no project called "${name}" on your desks`, hint: "leave project empty to use the desk's default project" };
  if (pick.length > 1) return { error: `"${name}" matches several projects; ask which one`, candidates: pick.map((p) => p.name) };
  return { id: pick[0].id, name: pick[0].name };
}

/** "2026-11-05T18:00" (IST, as the model writes it) -> an ISO time with the IST offset. */
function istTime(s) {
  const v = String(s || "").trim();
  if (!v) return null;
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T18:00:00+05:30` : `${v}${v.length === 16 ? ":00" : ""}+05:30`;
  const d = new Date(withZone);
  return Number.isNaN(+d) ? null : d.toISOString();
}

async function callBusyBee(ctx, method, body) {
  const cfg = ctx.busybeeApi;
  const r = await (ctx.fetch || fetch)(`${cfg.url}/api/tasks`, {
    method,
    headers: { "content-type": "application/json", "x-agent-secret": cfg.secret, "x-agent-telegram-id": String(ctx.member.telegramId) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  let j = {};
  try { j = await r.json(); } catch { /* not JSON */ }
  if (r.status === 401) return { error: "BusyBee didn't accept the agent (check AGENT_SHARED_SECRET on both BusyBee and the agent, and that this person's Telegram is linked in BusyBee)." };
  if (!r.ok) return { error: j.error || `BusyBee answered HTTP ${r.status}` };
  return j;
}

function ready(ctx) {
  if (!ctx.member) return { error: "Only GQuants team members can do this. Link your Telegram in BusyBee (Settings → Telegram) and ask again." };
  if (!ctx.projectDbs || !ctx.projectDbs.busybee) return { error: "BusyBee's database isn't connected to the agent (BUSYBEE_SUPABASE_URL/KEY)." };
  if (!ctx.busybeeApi) return { error: "BusyBee actions aren't switched on (BUSYBEE_APP_URL and BUSYBEE_AGENT_SECRET)." };
  return null;
}

const tools = [
  {
    name: "busybee_create_task",
    description: "Create a task in BusyBee for the person asking: for themselves, or (if their BusyBee role allows) assigned to a colleague, optionally as a to-do list of items. BusyBee needs a due date and time. Times are IST, written as 'YYYY-MM-DDTHH:MM' (a date alone means 6 pm). If the person, project or deadline is unclear, ask first instead of guessing. After creating, tell the person what was created, for whom, and the deadline.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        due: { type: "string", description: "IST, YYYY-MM-DDTHH:MM" },
        assignee: { type: "string", description: "name or email of the person who will do it; 'me' for the asker" },
        also: { type: "array", items: { type: "string" }, description: "other people who each get their own copy" },
        description: { type: "string" },
        priority: { type: "string", enum: PRIORITY, description: "default medium" },
        project: { type: "string", description: "project name (optional: the desk's default project otherwise)" },
        start: { type: "string", description: "optional start, IST" },
        items: { type: "array", items: { type: "string" }, description: "makes it a to-do list with these items" },
        personal: { type: "boolean", description: "a private to-do only the asker sees" },
      },
      required: ["title", "due", "assignee"],
    },
    async run(a, ctx) {
      const no = ready(ctx); if (no) return no;
      const db = ctx.projectDbs.busybee;
      markUsed(ctx, "busybee");
      const due = istTime(a.due);
      if (!due) return { error: "the due date isn't a valid date; use YYYY-MM-DDTHH:MM (IST)" };
      const who = await findPerson(db, ctx.member, a.assignee);
      if (who.error) return who;
      const others = [];
      for (const o of (a.also || []).slice(0, 20)) { const p = await findPerson(db, ctx.member, o); if (p.error) return p; others.push(p); }
      const proj = await findProject(db, ctx.member, a.project);
      if (proj.error) return proj;
      const body = {
        title: String(a.title || "").trim().slice(0, 300), due_date: due, assigned_to: who.id,
        ...(a.description ? { description: String(a.description).slice(0, 5000) } : {}),
        ...(PRIORITY.includes(a.priority) ? { priority: a.priority } : {}),
        ...(proj.id ? { project_id: proj.id } : {}),
        ...(a.start && istTime(a.start) ? { start_date: istTime(a.start) } : {}),
        ...(others.length ? { with: others.map((p) => p.id) } : {}),
        ...(a.personal ? { personal: true } : {}),
        ...(Array.isArray(a.items) && a.items.length ? { is_list: true, items: a.items.slice(0, 100).map((t) => ({ title: String(t).slice(0, 300) })) } : {}),
      };
      const r = await callBusyBee(ctx, "POST", body);
      if (r.error) return r;
      const t = r.task || {};
      return { created: { id: t.id, title: t.title, for: who.name, also: others.map((p) => p.name), due_ist: a.due, project: proj.name || "default project", priority: t.priority, items: t.subtask_count || 0 }, note: "BusyBee has sent its usual alert to the assignee." };
    },
  },
  {
    name: "busybee_update_task",
    description: "Change a BusyBee task for the person asking: status, progress, deadline, assignee, priority, title or description. Find the task's id first with project_query on busybee.tasks (e.g. title ilike). BusyBee's rules apply (for example the assignee can't move their own deadline; they can request an extension in the app).",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        status: { type: "string", enum: STATUS },
        progress_percent: { type: "integer" },
        due: { type: "string", description: "new deadline, IST YYYY-MM-DDTHH:MM" },
        assignee: { type: "string", description: "name or email" },
        priority: { type: "string", enum: PRIORITY },
        title: { type: "string" },
        description: { type: "string" },
      },
      required: ["task_id"],
    },
    async run(a, ctx) {
      const no = ready(ctx); if (no) return no;
      if (!UUID.test(String(a.task_id || ""))) return { error: "task_id must be the task's id (find it with project_query on busybee.tasks)" };
      markUsed(ctx, "busybee");
      const body = { id: a.task_id };
      if (a.status) { if (!STATUS.includes(a.status)) return { error: `status must be one of ${STATUS.join(", ")}` }; body.status = a.status; }
      if (a.progress_percent !== undefined) body.progress_percent = Math.max(0, Math.min(100, Math.round(+a.progress_percent || 0)));
      if (a.due) { const d = istTime(a.due); if (!d) return { error: "the due date isn't valid" }; body.due_date = d; }
      if (a.priority) body.priority = a.priority;
      if (a.title) body.title = String(a.title).slice(0, 300);
      if (a.description !== undefined) body.description = String(a.description).slice(0, 5000);
      if (a.assignee) { const p = await findPerson(ctx.projectDbs.busybee, ctx.member, a.assignee); if (p.error) return p; body.assigned_to = p.id; }
      if (Object.keys(body).length === 1) return { error: "say what to change" };
      const r = await callBusyBee(ctx, "PUT", body);
      if (r.error) return r;
      const t = r.task || {};
      return { updated: { id: a.task_id, title: t.title, status: t.status, progress_percent: t.progress_percent, due_date_utc: t.due_date } };
    },
  },
];

module.exports = { tools, findPerson, findProject, istTime, STATUS, PRIORITY };
