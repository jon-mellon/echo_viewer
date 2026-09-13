export function buildGroupEditorModel(group, { variables, workflowMode, phase }) {
  if (!group) return null;
  return {
    title: group.type === "dv" ? "Dependent variable group" : group.type === "iv" ? "Independent variable group" : "Group",
    choosingAnchor: workflowMode === "setup" && ["define_iv", "define_dv"].includes(phase),
    anchorButtonLabel: "Use as " + (phase === "define_dv" ? "DV" : "IV"),
    hint: "Edit variables, label and notes. Changes update the DAG immediately.",
    label: group.label || "", notes: group.notes || "",
    members: group.variable_ids.map(variableId => {
      const variable = variables.get(variableId);
      return { variableId, title: variable?.raw_variable_text || "", label: variable?.display_label || variableId };
    }),
  };
}
