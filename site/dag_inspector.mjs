import { directedGroupLabels } from "./dag_exports.mjs";
import { displayPaperTableKey } from "./dag_display.mjs";

export function diagnosticEvidenceDirection(link, {
  showConfoundersOnly = false,
  showCollidersOnly = false,
  confounderPathsByGroup = new Map(),
  colliderPathsByGroup = new Map(),
} = {}) {
  if (!link || (!showConfoundersOnly && !showCollidersOnly)) return null;
  const pathsByGroup = showConfoundersOnly ? confounderPathsByGroup : colliderPathsByGroup;
  const pathFields = showConfoundersOnly ? ["toIv", "toDv"] : ["fromIv", "fromDv"];
  let aToB = false;
  let bToA = false;
  for (const paths of pathsByGroup?.values?.() || []) {
    for (const field of pathFields) {
      const path = paths?.[field] || [];
      for (let index = 0; index < path.length - 1; index += 1) {
        const from = path[index], to = path[index + 1];
        if (from === link.group_a && to === link.group_b) aToB = true;
        if (from === link.group_b && to === link.group_a) bToA = true;
      }
    }
  }
  if (aToB === bToA) return null;
  return aToB ? "A_TO_B" : "B_TO_A";
}

export function edgeInspector(link, project, diagnosticView = {}) {
  if (!link) return null;
  const preferredDirection = diagnosticEvidenceDirection(link, diagnosticView);
  const forwardIds = link.a_to_b_raw_link_ids || [];
  const reverseIds = link.b_to_a_raw_link_ids || [];
  const rawIds = [...new Set(preferredDirection === "B_TO_A"
    ? [...reverseIds, ...forwardIds]
    : [...forwardIds, ...reverseIds])];
  return {
    ...directedGroupLabels(link, project.groups, "↔"),
    rawIds, rawCount: rawIds.length,
    existingDecision: project.link_decisions[link.edge_id],
    actions: [link.display_status === "excluded" || project.link_decisions[link.edge_id]?.display_status === "excluded"
      ? { action: "restore", label: "Restore" }
      : { action: "exclude", label: "Exclude" }],
  };
}

export function studyInspector(project, rawLinksById) {
  const link = project?.links?.find(candidate => candidate.is_target_relation);
  if (!link) return null;
  const rawIds = [...new Set([...(link.a_to_b_raw_link_ids || []), ...(link.b_to_a_raw_link_ids || [])])];
  const keys = [...new Set(rawIds.map(id => {
    const raw = rawLinksById.get(id);
    return raw ? displayPaperTableKey(`${raw.paper_id || "unknown"}::${raw.within_table_occurrence_id || "unknown"}`) : "";
  }).filter(Boolean))].slice(0, 8);
  return {
    sourceLabel: project.groups.find(g => g.group_id === project.iv_group_id)?.label || "IV",
    targetLabel: project.groups.find(g => g.group_id === project.dv_group_id)?.label || "DV",
    rawIds, keys,
  };
}

export function provenanceVariable(variableId, variables, groups) {
  const variable = variables.get(variableId);
  return {
    concept: variable?.concept_label || variable?.display_label || variableId || "",
    classifications: [...new Set(groups.filter(g => (g.variable_ids || []).includes(variableId))
      .map(g => g.label || g.group_id))],
  };
}

export function provenanceModel(link, project, rawLinksById, variables, diagnosticView = {}) {
  const edge = edgeInspector(link, project, diagnosticView);
  if (!edge) return null;
  const groupLabel = id => project.groups.find(group => group.group_id === id)?.label || id;
  const sections = [
    { direction: "A_TO_B", sourceLabel: groupLabel(link.group_a), targetLabel: groupLabel(link.group_b), rawIds: link.a_to_b_raw_link_ids || [] },
    { direction: "B_TO_A", sourceLabel: groupLabel(link.group_b), targetLabel: groupLabel(link.group_a), rawIds: link.b_to_a_raw_link_ids || [] },
  ];
  if (diagnosticEvidenceDirection(link, diagnosticView) === "B_TO_A") sections.reverse();
  const seen = new Set();
  const populatedSections = sections.map(section => ({
    ...section,
    rows: section.rawIds.filter(id => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }).map(id => rawLinksById.get(id)).filter(Boolean).map(raw => ({
      raw,
      source: provenanceVariable(raw.source_variable_id, variables, project.groups),
      target: provenanceVariable(raw.target_variable_id, variables, project.groups),
    })),
  }));
  return { ...edge, sections: populatedSections, rows: populatedSections.flatMap(section => section.rows) };
}

export function variableComparison(source, target, forwardIds, reverseIds, rawLinksById) {
  const rows = [
    ...forwardIds.map(id => ({ id, direction: "→" })),
    ...reverseIds.map(id => ({ id, direction: "←" })),
  ].map(({ id, direction }) => ({ ...rawLinksById.get(id), direction }))
    .filter(link => link.raw_causal_link_id);
  return { rows,
    sourceLabel: source.display_label || source.concept_label || source.variable_id,
    targetLabel: target.display_label || target.concept_label || target.variable_id,
  };
}
