// Search decisions only; callers supply visibility and unit-of-analysis policy.
const normalized = value => String(value ?? "").trim().toLowerCase();

export function anchorGroupSearchMatch(group, query, index, variableById, searchRecordById = null) {
  const labelMatches = !query || normalized(group.label || group.group_id).includes(query);
  let variableMatch = "";
  if (query && !labelMatches) {
    for (const variableId of group.variable_ids || []) {
      const variable = variableById.get(variableId) || searchRecordById?.get(variableId);
      if (!variable) continue;
      const fields = [
        variable.display_label,
        variable.concept_label,
        variable.raw_variable_text,
        variable.variable_id,
      ].filter(Boolean);
      const matchedField = fields.find((field) => normalized(field).includes(query));
      if (!matchedField) continue;
      variableMatch = matchedField;
      break;
    }
  }
  return {
    group,
    index,
    labelMatches,
    variableMatch,
    matches: labelMatches || Boolean(variableMatch),
  };
}

export function availableSetupAnchorGroups(project, side) {
  const currentId = side === "dv" ? project.dv_group_id : project.iv_group_id;
  const oppositeId = side === "dv" ? project.iv_group_id : project.dv_group_id;
  return (project?.groups || [])
    .filter((group) => group.variable_ids?.length)
    .filter((group) => group.group_id !== oppositeId)
    .filter((group) => group.group_id === currentId || !["iv", "dv"].includes(group.type));
}

export function searchVariables(query, { variables, selectedUoa, uoaFilterEnabled, uoaMatches }, limit = 20) {
  const terms = normalized(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const pool = (uoaFilterEnabled && selectedUoa)
    ? variables.filter(v => uoaMatches(v.uoa, selectedUoa))
    : variables;
  return pool
    .map((v) => {
      const haystack = normalized([v.variable_id, v.display_label, v.concept_label, v.raw_variable_text, v.paper_id, v.uoa].join(" "));
      if (!terms.every((t) => haystack.includes(t))) return null;
      let score = 0;
      const label = normalized(v.display_label || v.concept_label);
      const concept = normalized(v.concept_label);
      for (const t of terms) {
        if (label === t || concept === t) score += 20;
        else if (label.startsWith(t) || concept.startsWith(t)) score += 10;
        else score += 1;
      }
      return { variable: v, score };
    })
    .filter(Boolean)
    .sort((a, b) => (b.score - a.score) || (a.variable.index - b.variable.index))
    .slice(0, limit)
    .map((item) => item.variable);
}

export function groupNeighborSuggestions(group, {
  variableById, blockedIds, clusterMemberIds, rejectedIds = new Set(),
  selectedUoa, uoaFilterEnabled = false, uoaMatches,
}, limit) {
  const seen = new Set(group.variable_ids);
  const suggestions = [];
  for (const variableId of group.variable_ids) {
    const v = variableById.get(variableId);
    for (const neighbor of v?.similarity_neighbors || []) {
      if (seen.has(neighbor.variable_id)) continue;
      if (clusterMemberIds(neighbor.variable_id).some((id) => blockedIds.has(id) || rejectedIds.has(id))) continue;
      const candidate = variableById.get(neighbor.variable_id);
      if (!candidate) continue;
      if (uoaFilterEnabled && selectedUoa && !uoaMatches(candidate.uoa, selectedUoa)) continue;
      seen.add(neighbor.variable_id);
      suggestions.push(neighbor);
    }
  }
  return suggestions
    .sort((a, b) => (Number(a.llm_rank || 99) - Number(b.llm_rank || 99)) || (b.cosine_similarity - a.cosine_similarity))
    .slice(0, limit);
}

export function searchAnchorGroups(project, side, query, variableById, limit = 12, searchRecordById = null) {
  return availableSetupAnchorGroups(project, side)
    .map((group, index) => anchorGroupSearchMatch(group, normalized(query), index,
      variableById, searchRecordById))
    .filter(result => result.matches)
    .sort((a, b) => Number(b.labelMatches) - Number(a.labelMatches) || a.index - b.index)
    .slice(0, limit);
}
