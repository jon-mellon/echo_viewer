// List ordering and row descriptors; HTML and actions belong to the UI adapter.
export function buildGroupListModel(project, { candidateQueue, sort, activeGroupId, roleLabels }) {
  const queueMap = new Map(candidateQueue.map((item, index) => [item.group_id, { ...item, queueIndex: index }]));
  const anchorIds = new Set([project.iv_group_id, project.dv_group_id]);
  const groups = project.groups.slice().sort((a, b) => {
    const anchorOrder = Number(!anchorIds.has(a.group_id)) - Number(!anchorIds.has(b.group_id));
    if (anchorOrder) return anchorOrder;
    if (sort === "relevance") {
      const aQ = queueMap.get(a.group_id), bQ = queueMap.get(b.group_id);
      if (aQ && bQ) return aQ.queueIndex - bQ.queueIndex;
      if (aQ) return -1;
      if (bQ) return 1;
    }
    return a.label.localeCompare(b.label);
  });
  return {
    countText: groups.length + (groups.length === 1 ? " group" : " groups"),
    rows: groups.map(group => ({
      groupId: group.group_id,
      label: group.label || group.group_id,
      variableCount: group.variable_ids.length,
      isActive: group.group_id === activeGroupId,
      roleLabels: (queueMap.get(group.group_id)?.roles || []).slice(0, 2).map(role => roleLabels[role] || role),
      anchorLabel: anchorIds.has(group.group_id) ? (group.group_id === project.iv_group_id ? "IV" : "DV") : "",
    })),
  };
}
