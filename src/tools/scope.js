"use strict";
const { byId } = require("../projects");

/**
 * The project gate every project tool goes through. Tools for unselected
 * projects are not even declared to the model, and this check runs again at
 * call time, so a hallucinated or replayed call is refused all the same.
 */
function guardProject(ctx, project) {
  const id = String(project || "").trim().toLowerCase();
  if (!byId.has(id)) return { error: `unknown project "${String(project).slice(0, 40)}"` };
  if (!ctx.selected || !ctx.selected.includes(id)) {
    return {
      error: `Project "${id}" is not selected for this conversation, so it cannot be read. Tell the user to add "${byId.get(id).name}" in the project picker; do not guess what it contains.`,
      not_selected: true,
    };
  }
  return { id };
}

const markUsed = (ctx, id) => { if (ctx.projectsUsed) ctx.projectsUsed.add(id); };

module.exports = { guardProject, markUsed };
