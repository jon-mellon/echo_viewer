import { scopedDecisions } from "./confounder_status.mjs";

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

/** Review decisions affect presentation, while the study graph retains the baseline evidence. */
export function effectiveStudyGraph(project) {
  return { groups: project.groups || [], links: project.links || [], removed: new Set() };
}
