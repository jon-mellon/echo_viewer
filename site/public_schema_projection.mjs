// Only these decision fields are permitted in public schema and graph artifacts.
export function publicLinkDecisions(decisions = {}) {
  return Object.fromEntries(Object.entries(decisions).flatMap(([edgeId, decision]) => {
    const status = decision?.display_status === "hidden" ? "excluded" : decision?.display_status;
    return status === "excluded" ? [[edgeId, { display_status: "excluded" }]] : [];
  }));
}

export function publicFindingDecisions(decisions = {}) {
  return Object.fromEntries(Object.entries(decisions).flatMap(([rawId, decision]) =>
    decision?.display_status === "excluded" ? [[rawId, { display_status: "excluded" }]] : []));
}

export function publicSchemaProjection(schema) {
  const { link_decisions: _localDecisions, finding_decisions: _localFindings, ...rest } = schema;
  const linkDecisions = publicLinkDecisions(schema.link_decisions);
  const findingDecisions = publicFindingDecisions(schema.finding_decisions);
  return {
    ...rest,
    groups: (schema.groups || []).map(group => ({ ...group })),
    ...(Object.keys(linkDecisions).length ? { link_decisions: linkDecisions } : {}),
    ...(Object.keys(findingDecisions).length ? { finding_decisions: findingDecisions } : {}),
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
