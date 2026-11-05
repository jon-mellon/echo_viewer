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
  eligible.sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || ""))
    || String(a.group_id).localeCompare(String(b.group_id))
    || String(a.publication_id || "").localeCompare(String(b.publication_id || "")));
  const byName = new Map();
  for (const row of eligible) {
    const name = row.name.trim().toLowerCase();
    if (!byName.has(name)) byName.set(name, { ...row,
      source_labels: row.source_group_ids.map(id => current.get(id).label) });
  }
  return [...byName.values()];
}
