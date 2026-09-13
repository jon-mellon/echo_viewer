// @ts-check

/** @typedef {import("./app_contracts.mjs").DagAppState} DagAppState */

export function createDagAppState(interfaceMode = "classic") {
  return /** @type {DagAppState} */ ({
    interfaceMode,
    data: null,
    variables: [], variableById: new Map(), clusterOf: new Map(), clusterMembers: new Map(),
    rawLinks: [], rawLinksById: new Map(), linkLookup: new Map(), similarityEdgeMap: new Map(),
    project: null,
    seeds: { iv: new Set(), dv: new Set() },
    searchMatches: { iv: [], dv: [] },
    activeGroupId: null, focusedGroupId: null, selectedVariableId: null,
    comparisonVariableIds: [], hoveredVariableId: null, selectedEdgeId: null,
    candidateQueue: [], visibleLinks: [], componentGroupIds: new Set(),
    selectedUoa: null, uoaFilterEnabled: true,
    phase: "select_uoa", workflowMode: "setup", changingAnchorSide: null,
    anchorSearchMode: { iv: "existing", dv: "existing" }, groupListSort: "relevance",
    undoHistory: [], undoPointer: -1, actionLog: [], showActionHistory: false,
    definitionDraft: null,
    showVariableLabels: true, showGroupLabels: true, variableLayoutSource: "",
    projectStorageVariableCount: null, dagLayoutMode: "auto",
    filterDagByCausalRelevance: true, showConfoundersOnly: false, showCollidersOnly: false,
    confounderMaxPathLength: 1, excludeBottleneckedConfounders: true,
    hideIrrelevantConfounderLinks: true,
    confounderGroupIds: new Set(), confounderPathGroupIds: new Set(),
    confounderPathsByGroup: new Map(), confounderLinkPairKeys: new Set(),
    bottleneckedConfounderIds: new Set(),
    colliderGroupIds: new Set(), colliderPathGroupIds: new Set(),
    colliderPathsByGroup: new Map(), colliderLinkPairKeys: new Set(),
    bottleneckedColliderIds: new Set(),
    fullscreenPanel: null, selectedVariableIds: new Set(),
    mapContextMenu: { variableIds: [], variableId: null, clientX: 0, clientY: 0, query: "" },
    map: {
      canvas: null, ctx: null, dpr: 1,
      transform: { scale: 1, tx: 0, ty: 0 }, fitScale: 1,
      dragging: false, moved: false, dragStart: null, mode: "select", brush: null,
    },
  });
}
