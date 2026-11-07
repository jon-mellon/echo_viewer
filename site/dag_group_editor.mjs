export function buildGroupEditorModel(group, { variables, workflowMode, phase }) {
  if (!group) return null;
  return {
    title: group.type === "dv" ? "Outcome variable" : group.type === "iv" ? "Cause variable" : "Variable",
    choosingAnchor: workflowMode === "setup" && ["define_iv", "define_dv"].includes(phase),
    anchorButtonLabel: "Use as " + (phase === "define_dv" ? "outcome" : "cause"),
    hint: "Edit variables, label and notes. Changes update the graph immediately.",
    label: group.label || "", description: group.description || "", notes: group.notes || "",
    members: group.variable_ids.map(variableId => {
      const variable = variables.get(variableId);
      return { variableId, title: variable?.raw_variable_text || "", label: variable?.display_label || variableId };
    }),
  };
}
