export const PERSON_UOA_SENTINEL = "__person__";

export const PERSON_UOA_VALUES = new Set([
  "eligible voter",
  "voter",
  "adult citizen",
  "person",
  "citizen",
  "2012 obama voter",
  "legislator",
  "adult",
  "voter in u.s. presidential election",
  "white eligible voter",
  "white voter",
  "adult resident",
  "candidate",
  "eligible voter in poland",
  "adult in finland",
  "voter in a u.s. house election",
  "overseas or military eligible voter",
  "adult participant",
  "eligible voter in the uk",
  "ethnic minority adult",
  "white republican voter",
  "person-wave",
]);

export function uoaParts(value) {
  return String(value || "").split(",").map(part => part.trim().toLowerCase()).filter(Boolean);
}

export function uoaMatches(variableUoa, selected) {
  if (!selected) return true;
  const parts = uoaParts(variableUoa);
  if (!parts.length) return false;
  if (selected === PERSON_UOA_SENTINEL) {
    return parts.some(part => PERSON_UOA_VALUES.has(part));
  }
  return parts.includes(String(selected).trim().toLowerCase());
}

export function uoaCounts(variables = []) {
  const counts = new Map();
  for (const variable of variables) {
    for (const part of String(variable?.uoa || "").split(",").map(value => value.trim()).filter(Boolean)) {
      counts.set(part, (counts.get(part) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// Return a read-only projection for DAG derivation. Group definitions and the
// stored project remain untouched; only variables matching the active UOA can
// contribute nodes or evidence to the rendered graph.
export function projectForUoa(project, variableById, selectedUoa, enabled = true) {
  if (!project || !enabled || !selectedUoa) return project;
  return {
    ...project,
    groups: (project.groups || []).map(group => ({
      ...group,
      variable_ids: (group.variable_ids || []).filter(variableId =>
        uoaMatches(variableById.get(variableId)?.uoa, selectedUoa)),
    })),
  };
}
