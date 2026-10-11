import { deriveDagView } from "./dag_view.mjs";

// An exclusion belongs in the document only when reversing that one decision
// would put its edge in the current DAG view. The project itself is untouched.
export function relevantExclusions({ project, groups, links, rawLinksById, viewOptions = {} }) {
  const activeGroups = groups.filter(group => group.variable_ids?.length);
  const owners = new Map(activeGroups.flatMap(group =>
    group.variable_ids.map(variableId => [variableId, group.group_id])));
  const visible = candidateLinks => new Set(deriveDagView({
    groups: activeGroups, links: candidateLinks,
    ivId: project.iv_group_id, dvId: project.dv_group_id,
    instrumentId: project.instrument_group_id, ...viewOptions,
  }).visibleLinks.map(link => link.edge_id));

  const linkIds = Object.entries(project.link_decisions || {}).flatMap(([id, decision]) => {
    if (decision?.display_status !== "excluded" && decision?.display_status !== "hidden") return [];
    if (!links.some(link => link.edge_id === id)) return [];
    const restored = links.map(link => link.edge_id === id
      ? { ...link, display_status: "active_by_default" } : link);
    return visible(restored).has(id) ? [id] : [];
  });

  const findingIds = Object.entries(project.finding_decisions || {}).flatMap(([id, decision]) => {
    if (decision?.display_status !== "excluded") return [];
    const finding = rawLinksById.get(id);
    if (!finding) return [];
    const source = owners.get(finding.source_variable_id);
    const target = owners.get(finding.target_variable_id);
    if (!source || !target || source === target) return [];
    const existing = links.find(link =>
      (link.group_a === source && link.group_b === target)
      || (link.group_a === target && link.group_b === source));
    const targetPair = [source, target].includes(project.iv_group_id)
      && [source, target].includes(project.dv_group_id);
    const [groupA, groupB] = existing ? [existing.group_a, existing.group_b]
      : targetPair ? [project.iv_group_id, project.dv_group_id]
        : [source, target].sort();
    const edgeId = existing?.edge_id || `${groupA}__${groupB}`;
    const forward = targetPair || existing?.direction_type === "A_TO_B"
      || existing?.direction_type === "BIDIRECTIONAL" || source === groupA;
    const backward = existing?.direction_type === "B_TO_A"
      || existing?.direction_type === "BIDIRECTIONAL" || source === groupB;
    const restored = {
      ...existing, edge_id: edgeId, group_a: groupA, group_b: groupB,
      is_target_relation: targetPair || Boolean(existing?.is_target_relation),
      direction_type: forward && backward ? "BIDIRECTIONAL" : forward ? "A_TO_B" : "B_TO_A",
      display_status: existing?.display_status || project.link_decisions?.[edgeId]?.display_status || "active_by_default",
    };
    const candidateLinks = existing
      ? links.map(link => link.edge_id === edgeId ? restored : link)
      : [...links, restored];
    return visible(candidateLinks).has(edgeId) ? [id] : [];
  });

  return { linkIds, findingIds };
}
