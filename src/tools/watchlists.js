"use strict";
// The team's watchlists: named lists such as "india-holdings", "global-holdings"
// or "interest". Tasks and questions that say "our holdings" read them here, so
// changing a list changes every task that refers to it, with no task to edit.
//
//   watchlists       read, always available (also inside scheduled runs)
//   edit_watchlist   live chats only, admins only; writes the bot's own state file
const view = (l) => ({ name: l.name, description: l.description || "", count: l.items.length, items: l.items, updated: l.updatedAt ? l.updatedAt.slice(0, 10) : null });

const readTool = {
  name: "watchlists",
  description: "The team's saved watchlists (holdings, companies of interest, sectors, countries). Call it whenever a question or task mentions 'our holdings', 'our portfolio', 'our watchlist', 'stocks we own/track/are interested in', or names a list. With no name it returns every list; with a name, that list.",
  parameters: { type: "object", properties: { name: { type: "string", description: "optional list name, e.g. india-holdings" } } },
  async run(a, ctx) {
    const store = ctx.lists;
    if (!store) return { error: "watchlists are not available here" };
    if (a.name) {
      const l = store.getList(a.name);
      if (l) return view(l);
      return { error: `there is no list "${a.name}"`, lists: store.lists().map((x) => x.name) };
    }
    const all = store.lists();
    if (!all.length) return { lists: [], note: "No stock lists have been saved yet. An admin can create one just by asking, e.g. 'save our India stocks: HDFC Bank, Infosys, TCS'." };
    return { lists: all.map(view) };
  },
};

const editTool = {
  name: "edit_watchlist",
  description: "Create or change one of the TEAM'S lists saved inside this assistant (not anyone's watchlist on the heatmap dashboard website, which this assistant cannot change). Use it only when the person clearly asks for the team's list (e.g. 'our India holdings') and use it when an admin asks to add, remove or replace holdings or companies in a list, or to create, describe or delete a list. Items are short strings: company name plus ticker and market where known, e.g. 'HDFC Bank (NSE: HDFCBANK)', 'ASML (NASDAQ: ASML)', 'Indian private banks (sector)', 'Japan (macro)'. Confirm the resulting list to the user.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "add", "remove", "set", "describe", "delete"], description: "set replaces every item" },
      name: { type: "string", description: "list name, lower-case with dashes, e.g. india-holdings, global-holdings, interest, sectors, countries" },
      items: { type: "array", items: { type: "string" }, description: "for create, add, remove, set" },
      description: { type: "string", description: "what the list is for (create, describe)" },
    },
    required: ["action", "name"],
  },
  async run(a, ctx) {
    if (!ctx.lists || !ctx.task) return { error: "watchlists can only be changed in a live chat" };
    if (!ctx.task.admin) return { error: "only admins can change watchlists; ask an admin" };
    const r = ctx.lists.editList(a.action, a.name, { items: a.items, description: a.description, by: ctx.task.userLabel });
    if (r.error) return r;
    if (r.deleted) return { done: `list ${r.deleted} deleted` };
    return { done: view(r.list), ...(r.not_found ? { not_found: r.not_found } : {}) };
  },
};

module.exports = { readTool, editTool, view };
