import { directedGroupLabels } from "./dag_exports.mjs";
import { displayPaperTableKey } from "./dag_display.mjs";

export function edgeInspector(link, project) {
  if (!link) return null;
  const rawIds = [...new Set([...(link.a_to_b_raw_link_ids || []), ...(link.b_to_a_raw_link_ids || [])])];
  const manual = (link.manual_edge_ids || []).map(id => project.manual_edges.find(e => e.edge_id === id)).filter(Boolean);
  return {
    ...directedGroupLabels(link, project.groups, "↔"),
    rawIds, rawCount: rawIds.length, manual,
    existingDecision: project.link_decisions[link.edge_id],
    actions: [
      { action: "exclude", label: "Exclude" }, { action: "hide", label: "Hide" },
      { action: "restore", label: "Restore" },
      ...manual.map(e => ({ action: "delete-manual", label: "Remove manual", manualId: e.edge_id })),
    ],
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

export function provenanceModel(link, project, rawLinksById, variables) {
  const edge = edgeInspector(link, project);
  if (!edge) return null;
  return { ...edge, rows: edge.rawIds.map(id => rawLinksById.get(id)).filter(Boolean).map(raw => ({
    raw,
    source: provenanceVariable(raw.source_variable_id, variables, project.groups),
    target: provenanceVariable(raw.target_variable_id, variables, project.groups),
  })) };
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
