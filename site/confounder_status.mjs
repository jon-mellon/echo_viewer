export const CONFOUNDER_STATUSES = {
  unaddressed: "Unaddressed",
  explicitly_controlled: "Explicitly controlled",
  accounted_for_by_design: "Accounted for by design (e.g. time invariance)",
  other: "Other",
};

export function confounderKey(ivId, dvId, groupId) {
  return JSON.stringify([ivId, dvId, groupId]);
}

export function confounderRows(project, groupIds) {
  const groups = new Map((project.groups || []).map(group => [group.group_id, group]));
  return [...(groupIds || [])].filter(id => groups.has(id)).map(id => {
    const key = confounderKey(project.iv_group_id, project.dv_group_id, id);
    const decision = project.confounder_statuses?.[key] || {};
    return { groupId: id, label: groups.get(id).label || id, key,
      status: Object.hasOwn(CONFOUNDER_STATUSES, decision.status) ? decision.status : "unaddressed",
      text: decision.status === "other" ? (decision.text || "") : "" };
  }).sort((a, b) => a.label.localeCompare(b.label) || a.groupId.localeCompare(b.groupId));
}

export function publicConfounderStatuses(decisions = {}) {
  return Object.fromEntries(Object.entries(decisions).flatMap(([key, decision]) =>
    Object.hasOwn(CONFOUNDER_STATUSES, decision?.status)
      ? [[key, { status: decision.status }]] : []));
}
