import { customVariableContext, deleteSplitCategories } from "./dag_project.mjs";

/** A preview only: the live schema is changed when the replacement is saved. */
export function projectWithoutRoleSplit(project, role, expectedGroupId = null) {
  const id = role === "candidate" ? expectedGroupId : project?.[`${role}_group_id`];
  if (!id || expectedGroupId && id !== expectedGroupId || !customVariableContext(project, id)) return null;
  if (["iv", "dv", "instrument"].some(other => other !== role && project[`${other}_group_id`] === id)) return null;
  try {
    const restored = deleteSplitCategories(project, { groupId: id, timestamp: project.updated_at || "" });
    // Reusing a split keeps the current source names.
    return { ...restored, groups: restored.groups.map(group => ({ ...group,
      label: project.groups.find(current => current.group_id === group.group_id)?.label || group.label })) };
  } catch { return null; }
}

export function previousSplitsForRole(rows, project, role, selectedGroupId = null) {
  const ordinary = eligiblePreviousSplits(rows, project?.groups);
  const restored = projectWithoutRoleSplit(project, role, selectedGroupId);
  if (!restored) return ordinary;
  const id = role === "candidate" ? selectedGroupId : project[`${role}_group_id`];
  const selected = project.groups.find(group => group.group_id === id);
  const identity = new Set([id, selected.provenance?.split_id, selected.provenance?.reused_from_split_id,
    selected.provenance?.reused_from_group_id].filter(Boolean));
  const replacements = eligiblePreviousSplits(rows.filter(row =>
    ![row.group_id, row.split_id, row.origin_group_id, row.origin_split_id].some(key => key && identity.has(key))), restored.groups)
    .map(row => ({ ...row, replaces_group_id: id, replaces_label: selected.label }));
  return newestByName([...ordinary, ...replacements]);
}

/** Verify saved assignments against the current schema before offering a split. */
export function eligiblePreviousSplits(rows, groups) {
  const current = new Map((groups || []).map(group => [group.group_id, group]));
  const existingIds = new Set((groups || []).flatMap(group => [group.group_id, group.provenance?.split_id,
    group.provenance?.reused_from_split_id, group.provenance?.reused_from_group_id].filter(Boolean)));
  const currentNames = new Set((groups || []).map(group => String(group.label || "").trim().toLowerCase()));
  const eligible = rows.filter(row => {
    const sources = row.source_group_ids;
    const owners = row.source_group_by_variable;
    const selected = row.local_variable_ids;
    if (!row.name?.trim() || [...String(row.description || "").trim()].length < 20 || currentNames.has(row.name.trim().toLowerCase())
      || [row.group_id, row.split_id, row.origin_group_id, row.origin_split_id].some(id => id && existingIds.has(id))
      || !Array.isArray(sources) || !sources.length || new Set(sources).size !== sources.length
      || !owners || typeof owners !== "object" || Array.isArray(owners)
      || !Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length) return false;
    const entries = Object.entries(owners);
    if (!entries.length || entries.some(([, id]) => !sources.includes(id))) return false;
    const selectedSet = new Set(selected);
    if (selected.some(id => !Object.hasOwn(owners, id))) return false;
    return sources.every(id => {
      const group = current.get(id);
      const original = entries.filter(([, owner]) => owner === id).map(([variable]) => variable);
      const actual = group?.variable_ids;
      if (!group?.label?.trim() || !Array.isArray(actual) || !original.length
        || original.length !== actual.length || new Set(actual).size !== actual.length) return false;
      const actualSet = new Set(actual);
      return original.every(variable => actualSet.has(variable))
        && original.some(variable => !selectedSet.has(variable));
    });
  });
  return newestByName(eligible.map(row => ({ ...row,
    source_labels: row.source_group_ids.map(id => current.get(id).label) })));
}

function newestByName(rows) {
  rows.sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || ""))
    || String(a.group_id).localeCompare(String(b.group_id))
    || String(a.publication_id || "").localeCompare(String(b.publication_id || "")));
  const byName = new Map();
  for (const row of rows) {
    const name = row.name.trim().toLowerCase();
    if (!byName.has(name)) byName.set(name, row);
  }
  return [...byName.values()];
}
