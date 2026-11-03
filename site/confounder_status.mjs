export const CONFOUNDER_STATUSES = {
  unaddressed: "Unaddressed",
  explicitly_controlled: "Explicitly controlled",
  accounted_for_by_design: "Accounted for by design (e.g. time invariance)",
  other: "Other",
};

// A collider biases the estimate only when the analysis conditions on it, so its
// status records whether it was left out of the model and sample, or was not.
export const COLLIDER_STATUSES = {
  unaddressed: "Unaddressed",
  not_conditioned_on: "Not conditioned on",
  conditioned_by_design: "Conditioned on by design or sample selection",
  other: "Other",
};

/** Where each diagnostic keeps its statuses on the project, and which statuses it allows. */
export const DIAGNOSTIC_STATUSES = {
  confounders: { field: "confounder_statuses", statuses: CONFOUNDER_STATUSES, noun: "confounder" },
  colliders: { field: "collider_statuses", statuses: COLLIDER_STATUSES, noun: "collider" },
};

/** Shorter labels for the menus, where the full text does not fit. */
export const STATUS_MENU_LABELS = {
  accounted_for_by_design: "Accounted for by design",
  conditioned_by_design: "Conditioned on by design or sample",
};

export function confounderKey(ivId, dvId, groupId) {
  return JSON.stringify([ivId, dvId, groupId]);
}

/** One row per candidate with its recorded status ("unaddressed" when none), sorted by name. */
export function diagnosticStatusRows(project, groupIds, kind = "confounders") {
  const { field, statuses } = DIAGNOSTIC_STATUSES[kind];
  const groups = new Map((project.groups || []).map(group => [group.group_id, group]));
  return [...(groupIds || [])].filter(id => groups.has(id)).map(id => {
    const key = confounderKey(project.iv_group_id, project.dv_group_id, id);
    const decision = project[field]?.[key] || {};
    return { groupId: id, label: groups.get(id).label || id, key,
      status: Object.hasOwn(statuses, decision.status) ? decision.status : "unaddressed",
      text: decision.status === "other" ? (decision.text || "") : "" };
  }).sort((a, b) => a.label.localeCompare(b.label) || a.groupId.localeCompare(b.groupId));
}

export function confounderRows(project, groupIds) {
  return diagnosticStatusRows(project, groupIds, "confounders");
}

export function colliderRows(project, groupIds) {
  return diagnosticStatusRows(project, groupIds, "colliders");
}

/** The statuses safe to publish: the choice only, never the private "Other" text. */
export function publicDiagnosticStatuses(decisions = {}, statuses = CONFOUNDER_STATUSES) {
  return Object.fromEntries(Object.entries(decisions).flatMap(([key, decision]) =>
    Object.hasOwn(statuses, decision?.status)
      ? [[key, { status: decision.status }]] : []));
}

export function publicConfounderStatuses(decisions = {}) {
  return publicDiagnosticStatuses(decisions, CONFOUNDER_STATUSES);
}
