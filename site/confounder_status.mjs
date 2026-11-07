export const CONFOUNDER_STATUSES = {
  unaddressed: "Unaddressed",
  explicitly_controlled: "Explicitly controlled",
  accounted_for_by_design: "Accounted for by design",
  causes_y_only_via_x: "Affects outcome only via cause",
  not_in_minimal_adjustment_set: "Not in minimal adjustment set",
  removed_other: "Other reason",
};

export const EXCLUSION_STATUSES = {
  unaddressed: "Unaddressed",
  explicitly_controlled: "Explicitly controlled for",
  instrument_only_via_x: "Instrument affects variable only via cause",
  variable_only_via_x: "Affects outcome only via cause",
  removed_other: "Other reason",
};
export const CONTROL_WARNING = "Controlling for exclusion restriction violations can induce post treatment bias.";
// These dispositions keep the variable on the map and draw it faded.
export const LIGHT_STATUSES = new Set(["explicitly_controlled", "accounted_for_by_design", "not_in_minimal_adjustment_set",
  "causes_y_only_via_x", "instrument_only_via_x", "variable_only_via_x", "removed_other", "other"]);

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
  exclusion: { field: "exclusion_statuses", statuses: EXCLUSION_STATUSES, noun: "exclusion restriction violation" },
};

/** Shorter labels for the menus, where the full text does not fit. */
export const STATUS_MENU_LABELS = {
  accounted_for_by_design: "Accounted for by design",
  conditioned_by_design: "Conditioned on by design or sample",
};

export function confounderKey(ivId, dvId, groupId) {
  return JSON.stringify([ivId, dvId, groupId]);
}

export function diagnosticKey(project, kind, groupId) {
  return kind === "exclusion"
    ? JSON.stringify([project.instrument_group_id, project.iv_group_id, project.dv_group_id, groupId])
    : confounderKey(project.iv_group_id, project.dv_group_id, groupId);
}

export function scopedDecisions(project, kind) {
  const spec = DIAGNOSTIC_STATUSES[kind];
  if (!spec) return [];
  return Object.entries(project[spec.field] || {}).flatMap(([key, decision]) => {
    try {
      const parts = JSON.parse(key);
      const id = Array.isArray(parts) && parts.at(-1);
      return id && diagnosticKey(project, kind, id) === key ? [{ groupId: id, key, ...decision }] : [];
    } catch { return []; }
  });
}

/** One row per candidate with its recorded status ("unaddressed" when none), sorted by name. */
export function diagnosticStatusRows(project, groupIds, kind = "confounders") {
  const { field, statuses } = DIAGNOSTIC_STATUSES[kind];
  const groups = new Map((project.groups || []).map(group => [group.group_id, group]));
  return [...(groupIds || [])].filter(id => groups.has(id)).map(id => {
    const key = diagnosticKey(project, kind, id);
    const decision = project[field]?.[key] || {};
    return { groupId: id, label: groups.get(id).label || id, key,
      status: Object.hasOwn(statuses, decision.status) || decision.status === "other" ? decision.status : "unaddressed",
      text: ["other", "removed_other"].includes(decision.status) ? (decision.text || "") : "" };
  }).sort((a, b) => a.label.localeCompare(b.label) || a.groupId.localeCompare(b.groupId));
}

export function confounderRows(project, groupIds) {
  return diagnosticStatusRows(project, groupIds, "confounders");
}

export function colliderRows(project, groupIds) {
  return diagnosticStatusRows(project, groupIds, "colliders");
}

export function diagnosticReviewRows(project, groupIds, kind = "confounders") {
  const candidates = new Set(groupIds || []);
  const retained = scopedDecisions(project, kind).filter(row => row.status !== "unaddressed").map(row => row.groupId);
  return diagnosticStatusRows(project, new Set([...candidates, ...retained]), kind).map(row => ({ ...row,
    rejected: !candidates.has(row.groupId),
    noLongerCandidate: !candidates.has(row.groupId) }));
}

/** The statuses safe to publish: the choice only, never the private "Other" text. */
export function publicDiagnosticStatuses(decisions = {}, statuses = CONFOUNDER_STATUSES) {
  return Object.fromEntries(Object.entries(decisions).flatMap(([key, decision]) =>
    Object.hasOwn(statuses, decision?.status) || decision?.status === "other"
      ? [[key, { status: decision.status }]] : []));
}

export function publicConfounderStatuses(decisions = {}) {
  return publicDiagnosticStatuses(decisions, CONFOUNDER_STATUSES);
}
