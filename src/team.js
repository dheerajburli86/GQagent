"use strict";
// Who is a GQuants team member? Someone whose Telegram is linked to their BusyBee
// account (BusyBee → Settings → Telegram). That link already exists for BusyBee's
// own alerts, so there is no list to keep here: join BusyBee, link Telegram, and
// the agent knows you. Team members get the project databases and BusyBee
// actions; everyone else gets the public features (questions, web, files, maths).
const ORDER = ["member", "manager", "supervisor", "admin"];
const normRole = (r) => {
  const x = String(r || "").trim().toLowerCase();
  if (["owner", "administrator", "superadmin", "super_admin"].includes(x)) return "admin";
  return ORDER.includes(x) ? x : "member";
};

class Team {
  constructor({ busybee, ttlMs = 5 * 60e3, log = () => {} }) {
    this.db = busybee; // a ProjectDb for BusyBee, or null
    this.ttl = ttlMs;
    this.log = log;
    this.cache = new Map();
  }

  get available() { return !!this.db; }

  /** Returns { userId, name, email, role, desks: [{desk_id, role}] } or null. */
  async member(telegramId) {
    if (!this.db || !/^\d{1,20}$/.test(String(telegramId || ""))) return null;
    const key = String(telegramId);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttl) return hit.v;
    let v = null;
    try {
      const link = await this.db.from("user_telegram").select("user_id").eq("chat_id", key).maybeSingle();
      if (link.error) throw new Error(link.error.message);
      if (link.data && link.data.user_id) {
        const uid = link.data.user_id;
        const [u, d] = await Promise.all([
          this.db.from("users").select("id, full_name, email").eq("id", uid).maybeSingle(),
          this.db.from("desk_members").select("desk_id, role").eq("user_id", uid),
        ]);
        const desks = ((d && d.data) || []).map((m) => ({ desk_id: m.desk_id, role: normRole(m.role) }));
        const role = desks.reduce((best, m) => (ORDER.indexOf(m.role) > ORDER.indexOf(best) ? m.role : best), "member");
        v = { userId: uid, name: (u.data && u.data.full_name) || null, email: (u.data && u.data.email) || null, role, desks };
      }
    } catch (e) {
      this.log(`[team] lookup failed: ${String(e.message || e).slice(0, 120)}`);
      return hit ? hit.v : null; // keep the last answer through a blip
    }
    this.cache.set(key, { v, at: Date.now() });
    return v;
  }
}

module.exports = { Team, normRole };
