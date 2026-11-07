// Variable definitions are reusable independently of any study assumptions.
const DECISION_FIELDS = ["confounder_statuses", "collider_statuses", "exclusion_statuses",
  "link_decisions", "finding_decisions", "finding_reviews"];
const STUDY_FIELDS = [...DECISION_FIELDS, "iv_group_id", "dv_group_id", "instrument_group_id", "decisions", "filters", "project_id"];

export function variableSchema(schema) {
  const result = Object.fromEntries(Object.entries(schema).filter(([key]) => !STUDY_FIELDS.includes(key)));
  return { ...result,
    ...(Array.isArray(result.hidden_variable_ids) ? { hidden_variable_ids: [...new Set(result.hidden_variable_ids)].sort() } : {}),
    ...(Array.isArray(result.rejected_variables) ? { rejected_variables: result.rejected_variables.map(item => ({ ...item,
      member_variable_ids: [...(item.member_variable_ids || [])].sort(), previous_group_ids: [...(item.previous_group_ids || [])].sort(),
    })).sort((a, b) => String(a.variable_id).localeCompare(String(b.variable_id))) } : {}),
    groups: (schema.groups || []).map(group => {
    const { type, ...definition } = group;
    const normalized = { ...definition, variable_ids: [...new Set(group.variable_ids || [])].sort() };
    return type && !["iv", "dv", "instrument", "candidate"].includes(type) ? { ...normalized, type } : normalized;
  }).sort((a, b) => String(a.group_id).localeCompare(String(b.group_id))) };
}

export function studyDecisionBundle(schema) {
  return { format_version: "echo-study-decisions-v1",
    ...Object.fromEntries(DECISION_FIELDS.filter(key => Object.hasOwn(schema, key)).map(key => [key, schema[key]])) };
}
