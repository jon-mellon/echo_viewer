import { diagnosticKey, scopedDecisions } from "./confounder_status.mjs";

export const effectKey = ({ sourceId, targetId }) => JSON.stringify([sourceId, targetId]);

export function directedEffects(links, { includeExcluded = false } = {}) {
  return (links || []).flatMap(link => {
    if (!includeExcluded && link.display_status === "excluded") return [];
    const effects = [];
    if (["A_TO_B", "BIDIRECTIONAL"].includes(link.direction_type)) effects.push({ sourceId: link.group_a, targetId: link.group_b });
    if (["B_TO_A", "BIDIRECTIONAL"].includes(link.direction_type)) effects.push({ sourceId: link.group_b, targetId: link.group_a });
    return effects;
  });
}

export function activeStudyDecisions(project, omitKey = null) {
  return ["confounders", "exclusion"].flatMap(kind => scopedDecisions(project, kind)
    .filter(row => row.key !== omitKey).map(row => ({ ...row, kind })));
}

/**
 * Baseline groups and evidence links stay immutable. A variable removed for another reason leaves this study's
 * graph; every other disposition only changes how its node is drawn.
 */
export function effectiveStudyGraph(project, { omitKey = null } = {}) {
  const decisions = activeStudyDecisions(project, omitKey);
  const anchors = new Set([project.iv_group_id, project.dv_group_id, project.instrument_group_id]);
  const removed = new Set(decisions.filter(row => row.status === "removed_other" && !anchors.has(row.groupId)).map(row => row.groupId));
  const groups = (project.groups || []).filter(group => !removed.has(group.group_id));
  const ids = new Set(groups.map(group => group.group_id));
  const links = (project.links || []).filter(link => ids.has(link.group_a) && ids.has(link.group_b));
  return { groups, links, removed };
}
