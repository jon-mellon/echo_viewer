// Pure workflow patches. Project edits, focus, map fitting and rendering belong
// to the caller; transitions never mutate the supplied state.
export function restoreWorkflowMode(mode, phase) {
  if (mode === "dag_review") return "group_review";
  return ["setup", "group_review"].includes(mode) ? mode : phase === "build" ? "group_review" : "setup";
}

export function missingAnchorWorkflow(selectedUoa) {
  return { phase: "select_dv", workflowMode: "setup" };
}

export function transition(state, event) {
  switch (event.type) {
    case "reset-uoa":
      return { selectedUoa: null, uoaFilterEnabled: event.filterEnabled ?? true,
        phase: event.nextPhase || "select_uoa" };
    case "clear-editor":
      return { activeGroupId: null, focusedGroupId: null };
    case "focus-group":
      return { focusedGroupId: event.groupId };
    case "review-group":
      return { workflowMode: "group_review", activeGroupId: event.groupId, focusedGroupId: event.groupId };
    case "grouping-imported":
      return { workflowMode: "group_review", focusedGroupId: event.groupId,
        ...(event.anchorsReady ? { phase: "build" } : {}) };
    case "mode": {
      if (event.mode === state.workflowMode) return {};
      const ready = ["iv", "dv"].every(side => state.project?.groups.find(
        group => group.group_id === state.project[side + "_group_id"])?.variable_ids?.length);
      return { workflowMode: event.mode,
        phase: event.mode === "group_review" && ready ? "build" : state.phase,
        changingAnchorSide: event.mode !== "setup" && !state.activeGroupId ? null : state.changingAnchorSide };
    }
    case "uoa":
      return { selectedUoa: event.uoa, uoaFilterEnabled: true,
        phase: event.nextPhase || "select_dv" };
    case "change-anchor":
      return { changingAnchorSide: event.side, workflowMode: "setup", phase: "select_" + event.side,
        anchorSearchMode: { ...state.anchorSearchMode, [event.side]: "existing" },
        seeds: { ...state.seeds, [event.side]: new Set() },
        searchMatches: { ...state.searchMatches, [event.side]: [] },
        activeGroupId: null, focusedGroupId: event.groupId };
    case "open-editor":
      return { activeGroupId: event.groupId, focusedGroupId: event.groupId,
        ...(event.side ? { phase: "define_" + event.side } : {}) };
    case "close-editor":
      return { activeGroupId: null, focusedGroupId: null,
        phase: state.phase === "define_dv" ? "select_dv" : state.phase === "define_iv" ? "select_iv" : state.phase };
    case "anchor-selected": {
      const replacing = state.changingAnchorSide === event.side;
      if (event.alreadyCurrent || replacing) {
        return { changingAnchorSide: null, phase: "build", workflowMode: "group_review",
          activeGroupId: null, focusedGroupId: event.groupId };
      }
      if (state.interfaceMode === "dag2") {
        return event.side === "iv"
          ? { phase: "select_dv", activeGroupId: null, focusedGroupId: event.groupId }
          : { phase: "build", workflowMode: "group_review", activeGroupId: null,
              focusedGroupId: event.groupId };
      }
      return { phase: event.side === "dv" ? "select_iv" : "schema_choice",
        activeGroupId: null, focusedGroupId: event.fromEditor ? null : event.groupId };
    }
    case "finish-schema":
      return { phase: "build", workflowMode: "group_review", activeGroupId: null, focusedGroupId: null };
    default:
      throw new Error("Unknown workflow transition: " + event.type);
  }
}
