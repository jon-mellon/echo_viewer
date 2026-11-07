// Only these decision fields are permitted in public schema and graph artifacts.
import { COLLIDER_STATUSES, EXCLUSION_STATUSES, publicConfounderStatuses, publicDiagnosticStatuses } from "./confounder_status.mjs";
export function publicLinkDecisions(decisions = {}) {
  return Object.fromEntries(Object.entries(decisions).flatMap(([edgeId, decision]) => {
    const status = decision?.display_status === "hidden" ? "excluded" : decision?.display_status;
    return status === "excluded" ? [[edgeId, { display_status: "excluded" }]] : [];
  }));
}

export function publicFindingDecisions(decisions = {}) {
  return Object.fromEntries(Object.entries(decisions).flatMap(([rawId, decision]) =>
    decision?.display_status === "excluded" ? [[rawId, {
      display_status: "excluded",
      ...(["not_relevant_to_target_population", "concept_miscategorized", "other"].includes(decision.reason_code)
        ? { reason_code: decision.reason_code } : {}),
    }]] : []));
}

export function publicSchemaProjection(schema) {
  const { link_decisions: _localDecisions, finding_decisions: _localFindings,
    finding_reviews: _localReviews,
    confounder_statuses: _localConfounders, collider_statuses: _localColliders, exclusion_statuses: _localExclusion, ...rest } = schema;
  const colliderStatuses = publicDiagnosticStatuses(schema.collider_statuses, COLLIDER_STATUSES);
  const linkDecisions = publicLinkDecisions(schema.link_decisions);
  const findingDecisions = publicFindingDecisions(schema.finding_decisions);
  return {
    ...rest,
    groups: (schema.groups || []).map(group => ({ ...group })),
    ...(Object.keys(linkDecisions).length ? { link_decisions: linkDecisions } : {}),
    ...(Object.keys(findingDecisions).length ? { finding_decisions: findingDecisions } : {}),
    ...(Object.keys(publicConfounderStatuses(schema.confounder_statuses)).length
      ? { confounder_statuses: publicConfounderStatuses(schema.confounder_statuses) } : {}),
    ...(Object.keys(colliderStatuses).length ? { collider_statuses: colliderStatuses } : {}),
    ...(Object.keys(schema.exclusion_statuses || {}).length
      ? { exclusion_statuses: publicDiagnosticStatuses(schema.exclusion_statuses, EXCLUSION_STATUSES) } : {}),
  };
}

export function publicCompiledDag(dag, decisions = {}) {
  if (!dag) return null;
  const safe = publicLinkDecisions(decisions);
  const stripReasonFields = value => {
    if (Array.isArray(value)) return value.map(stripReasonFields);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !/reason/i.test(key))
        .map(([key, item]) => [key, stripReasonFields(item)]));
    }
    return value;
  };
  return {
    ...dag,
    edges: (dag.edges || []).map(edge => {
      const { user_decision: _privateDecision, ...sourceEdge } = edge;
      const publicEdge = stripReasonFields(sourceEdge);
      const status = safe[edge.edge_id]?.display_status
        || (edge.display_status === "excluded" ? "excluded" : "active_by_default");
      return { ...publicEdge, display_status: status,
        user_decision: status === "excluded" ? { display_status: "excluded" } : null };
    }),
  };
}
