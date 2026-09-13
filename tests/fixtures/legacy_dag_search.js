// Frozen pre-extraction search algorithms for compatibility checks.
function anchorGroupSearchMatch(group, query, index) {
  const labelMatches = !query || normalized(group.label || group.group_id).includes(query);
  let variableMatch = "";
  if (query && !labelMatches) {
    for (const variableId of group.variable_ids || []) {
      const variable = state.variableById.get(variableId);
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

function availableSetupAnchorGroups(side) {
  const currentId = side === "dv" ? state.project.dv_group_id : state.project.iv_group_id;
  const oppositeId = side === "dv" ? state.project.iv_group_id : state.project.dv_group_id;
  return (state.project?.groups || [])
    .filter((group) => group.variable_ids?.length)
    .filter((group) => group.group_id !== oppositeId)
    .filter((group) => group.group_id === currentId || !["iv", "dv"].includes(group.type));
}

function searchVariables(query, limit = 20) {
  const terms = normalized(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const pool = (state.uoaFilterEnabled && state.selectedUoa)
    ? visibleVariables().filter(v => uoaMatches(v.uoa, state.selectedUoa))
    : visibleVariables();
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

function groupNeighborSuggestions(group, limit) {
  const blockedIds = groupedVariableIds();
  const seen = new Set(group.variable_ids);
  const suggestions = [];
  for (const variableId of group.variable_ids) {
    const v = state.variableById.get(variableId);
    for (const neighbor of v?.similarity_neighbors || []) {
      if (seen.has(neighbor.variable_id)) continue;
      if (clusterMemberIds(neighbor.variable_id).some((id) => blockedIds.has(id))) continue;
      seen.add(neighbor.variable_id);
      suggestions.push(neighbor);
    }
  }
  return suggestions
    .filter((n) => state.variableById.has(n.variable_id))
    .sort((a, b) => (Number(a.llm_rank || 99) - Number(b.llm_rank || 99)) || (b.cosine_similarity - a.cosine_similarity))
    .slice(0, limit);
}
