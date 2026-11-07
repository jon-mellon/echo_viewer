import * as projectOps from "./dag_project.mjs";

export function createDagEventController({
  state, elements: els, dagNetwork,
  activeGroup, renderNeighborSuggestions, renderAll,
  renderSearch, prefetchVariableSearch, toggleAnchorSearchMode, finishSchemaChoice,
  changeAnchor, renderSetupGroupPicker,
  setWorkflowMode, renderGroupList, closeGroupEditor, discardGroupEditor, selectActiveAnchor,
  addTopNeighborsToActiveGroup, removeTopNeighborsFromActiveGroup, clearActiveGroupVariables,
  renderGroupSeedSearch, renderRejectedVariablesPanel, applyProjectOperation,
  saveProjectLocally, applyActiveGroupingSet, rebuildProject, updateDagFilters, exportGroupingFolder,
  copyPermalink, toggleFullscreenPanel, renderMapToolbarToggles, clampNumber,
  undo, redo, renderActionHistory, renderDag, setFullscreenPanel,
  createCustomGroup, exportProject, exportWorkingMap, importProject, exportBib, exportMd,
  exportTex, installDagHandlers, initPanelResizers, takeSnapshot,
  addToUndoHistory, clusterRep, addVariableToGroup, clean, startEditSplit,
  dismissEvidencePane, showExcludedLinks, showExcludedFindings, startDefinition,
}) {
function installHandlers() {
  els.closeEvidencePane.addEventListener("click", dismissEvidencePane);
  els.showExcludedLinks.addEventListener("click", showExcludedLinks);
  els.showExcludedFindings.addEventListener("click", showExcludedFindings);
  // Anchor search
  els.ivInput.addEventListener("focus", () => { void prefetchVariableSearch(); });
  els.dvInput.addEventListener("focus", () => { void prefetchVariableSearch(); });
  els.instrumentInput.addEventListener("focus", () => { void prefetchVariableSearch(); });
  els.ivInput.addEventListener("input", () => renderSearch("iv"));
  els.dvInput.addEventListener("input", () => renderSearch("dv"));
  els.instrumentInput.addEventListener("input", () => renderSetupGroupPicker("instrument"));
  els.ivDefineNew.addEventListener("click", () => toggleAnchorSearchMode("iv"));
  els.dvDefineNew.addEventListener("click", () => toggleAnchorSearchMode("dv"));

  // Schema choice
  els.loadSchema.addEventListener("click", () => finishSchemaChoice(true));
  els.skipSchema.addEventListener("click", () => finishSchemaChoice(false));

  // Change the selected groups.
  els.changeDv.addEventListener("click", () => changeAnchor("dv"));
  els.changeIv.addEventListener("click", () => changeAnchor("iv"));
  // In Explore the whole selected-variable control reopens the variable picker.
  els.exploreFocusSelector?.addEventListener("click", () => changeAnchor("iv"));
  els.changeInstrument.addEventListener("click", () => changeAnchor("instrument"));
  els.instrumentDefineNew.addEventListener("click", () => startDefinition("instrument"));
  els.variableDefineNew?.addEventListener("click", () => startDefinition("candidate"));
  els.editSplitDv?.addEventListener("click", () => startEditSplit(state.project.dv_group_id));
  els.editSplitIv?.addEventListener("click", () => startEditSplit(state.project.iv_group_id));

  // Mode switcher
  els.modeSwitcher.querySelectorAll(".mode-tab").forEach((tab) => {
    tab.addEventListener("click", () => setWorkflowMode(tab.dataset.mode));
  });

  // Group list: sort
  els.groupListSort.addEventListener("change", () => {
    state.groupListSort = els.groupListSort.value;
    renderGroupList();
  });

  // Group editor (right panel)
  els.cancelGroupEdit.addEventListener("click", closeGroupEditor);
  els.discardGroupEdit?.addEventListener("click", discardGroupEditor);
  els.useGroupAsAnchor.addEventListener("click", selectActiveAnchor);
  els.addNeighbors.addEventListener("click", addTopNeighborsToActiveGroup);
  els.removeNeighbors.addEventListener("click", removeTopNeighborsFromActiveGroup);
  els.clearGroupSelection.addEventListener("click", clearActiveGroupVariables);
  els.groupSeedInput.addEventListener("input", renderGroupSeedSearch);
  els.rejectedVariableSearch?.addEventListener("input", renderRejectedVariablesPanel);
  els.editSplit?.addEventListener("click", startEditSplit);
  els.groupLabelInput.addEventListener("input", () => {
    const group = activeGroup();
    if (group) applyProjectOperation(projectOps.updateGroup(state.project, group.group_id, { label: els.groupLabelInput.value.trim() }));
    renderGroupList();
    renderDag();
    saveProjectLocally();
  });
  els.groupNotesInput.addEventListener("input", () => {
    const group = activeGroup();
    if (group) applyProjectOperation(projectOps.updateGroup(state.project, group.group_id, { notes: els.groupNotesInput.value }));
    saveProjectLocally();
  });

  // Grouping schema
  els.groupingSetSelect.addEventListener("change", () => {
    state.project.active_grouping_set_id = els.groupingSetSelect.value;
    applyActiveGroupingSet();
    rebuildProject();
  });
  els.exportGroupingFolder.addEventListener("click", exportGroupingFolder);
  els.copyPermalink.addEventListener("click", copyPermalink);

  els.toggleConfoundersOnly.addEventListener("click", () => {
    state.showExclusionViolations = false;
    state.showExogeneity = false;
    state.showConfoundersOnly = true;
    state.showCollidersOnly = false;
    updateDagFilters();
  });
  els.toggleCollidersOnly.addEventListener("click", () => {
    state.showExclusionViolations = false;
    state.showExogeneity = false;
    state.showCollidersOnly = true;
    state.showConfoundersOnly = false;
    updateDagFilters();
  });
  els.toggleExclusionViolations.addEventListener("click", () => {
    state.showExclusionViolations = true;
    state.showExogeneity = false;
    state.showConfoundersOnly = false;
    state.showCollidersOnly = false;
    updateDagFilters();
  });
  els.toggleExogeneity.addEventListener("click", () => {
    state.showExogeneity = true;
    state.showExclusionViolations = false;
    state.showConfoundersOnly = false;
    state.showCollidersOnly = false;
    updateDagFilters();
  });
  els.confounderPathLength.addEventListener("input", () => {
    const requested = Math.trunc(Number(els.confounderPathLength.value));
    const minimum = state.showExclusionViolations ? 2 : 1;
    if (!Number.isFinite(requested) || requested < minimum) return;
    const field = state.showExclusionViolations ? "exclusionMaxPathLength" : "confounderMaxPathLength";
    state[field] = clampNumber(requested, minimum, 99);
    els.confounderPathLength.value = String(state[field]);
    if (!state.showCollidersOnly && !state.showExclusionViolations && !state.showExogeneity) state.showConfoundersOnly = true;
    updateDagFilters();
  });
  els.confounderPathLength.addEventListener("change", () => {
    const field = state.showExclusionViolations ? "exclusionMaxPathLength" : "confounderMaxPathLength";
    if (Number(els.confounderPathLength.value) < (state.showExclusionViolations ? 2 : 1)) {
      els.confounderPathLength.value = String(state[field]);
    }
  });
  els.toggleSparseEdges.addEventListener("click", () => {
    state.excludeSparseEdges = !state.excludeSparseEdges;
    updateDagFilters();
  });
  els.minimumEdgePapers.addEventListener("input", () => {
    const requested = Math.trunc(Number(els.minimumEdgePapers.value));
    if (!Number.isSafeInteger(requested) || requested < 1) return;
    // Typing a minimum applies it; one paper means no minimum, as in Explore's filters.
    state.excludeSparseEdges = requested > 1;
    if (requested > 1) state.minimumEdgePapers = requested;
    updateDagFilters();
  });
  els.minimumEdgePapers.addEventListener("change", () => {
    els.minimumEdgePapers.value = String(state.excludeSparseEdges ? state.minimumEdgePapers : 1);
  });
  els.toggleBottleneckedConfounders.addEventListener("click", () => {
    state.excludeBottleneckedConfounders = !state.excludeBottleneckedConfounders;
    if (!state.showCollidersOnly && !state.showExogeneity) state.showConfoundersOnly = true;
    updateDagFilters();
  });
  els.toggleIrrelevantConfounderLinks.addEventListener("click", () => {
    state.hideIrrelevantConfounderLinks = !state.hideIrrelevantConfounderLinks;
    if (!state.showCollidersOnly && !state.showExogeneity) state.showConfoundersOnly = true;
    updateDagFilters();
  });
  els.toggleAllExclusionLinks.addEventListener("click", () => {
    state.showAllExclusionLinks = !state.showAllExclusionLinks;
    updateDagFilters();
  });

  // Undo / redo / history
  els.undoBtn.addEventListener("click", undo);
  els.redoBtn.addEventListener("click", redo);
  // The History menu lists undo steps while it is open.
  const historyMenu = /** @type {HTMLDetailsElement | null} */ (document.getElementById("historyMenu"));
  historyMenu?.addEventListener("toggle", () => {
    state.showActionHistory = historyMenu.open;
    renderActionHistory();
  });
  // Ctrl/⌘+Z undoes; Ctrl/⌘+Shift+Z or Ctrl+Y redoes. Typing in a field keeps the browser's own undo.
  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    const target = /** @type {HTMLElement | null} */ (event.target instanceof HTMLElement ? event.target : null);
    if (target?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
    // A modal dialog owns the keyboard: do not edit the project behind it.
    if (document.querySelector("dialog[open]")) return;
    event.preventDefault();
    if (key === "y" || event.shiftKey) { if (!els.redoBtn.disabled) redo(); }
    else if (!els.undoBtn.disabled) undo();
  });

  // DAG SVG zoom controls
  els.dagSvgZoomIn.addEventListener("click", () => {
    dagNetwork.zoomIn();
  });
  els.dagSvgZoomOut.addEventListener("click", () => {
    dagNetwork.zoomOut();
  });
  els.dagSvgFit.addEventListener("click", () => {
    dagNetwork.fit();
  });
  els.fullscreenDag.addEventListener("click", () => toggleFullscreenPanel("dag"));
  els.dagTableSkip.addEventListener("click", () => dagNetwork.setDagDisplay("table", { focusTable: true }));
  for (const [button, mode] of [[els.dagViewGraph, "graph"], [els.dagViewTable, "table"]]) {
    button.addEventListener("click", () => dagNetwork.setDagDisplay(mode));
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.fullscreenPanel) setFullscreenPanel(null);
  });

  // Create custom group
  els.createGroupBtn.addEventListener("click", createCustomGroup);

  // Top-bar menus behave like ordinary menus: choosing an item closes the menu,
  // except items that report progress in place (data-keep-open) and file pickers,
  // which close once a file has been chosen.
  for (const menu of document.querySelectorAll("#taskBar details.nav-menu")) {
    menu.addEventListener("click", (event) => {
      const item = /** @type {Element} */ (event.target).closest?.(".menu-item");
      if (!item || item.matches("[data-keep-open], .file-button, .edit-history-entry")) return;
      /** @type {HTMLDetailsElement} */ (menu).open = false;
    });
    // Choosing a file, or a schema in the Schema menu's switcher, also closes it.
    menu.addEventListener("change", (event) => {
      const target = /** @type {HTMLInputElement} */ (event.target);
      if (target.type === "file" || target.id === "groupingSetSelect") /** @type {HTMLDetailsElement} */ (menu).open = false;
    });
  }

  // Narrow screens: the hamburger button shows the task switcher, view switches,
  // undo and redo and the History, Schema, Import and Export menus as one panel,
  // each menu expanding in place. Choosing an item closes the panel.
  const navToggle = document.getElementById("navToggle");
  const navOverflow = document.getElementById("taskBarOverflow");
  const setNavOpen = (/** @type {boolean} */ open) => {
    if (!navToggle || !navOverflow) return;
    navOverflow.classList.toggle("is-open", open);
    navToggle.setAttribute("aria-expanded", String(open));
    if (!open) for (const menu of navOverflow.querySelectorAll("details[open]")) /** @type {HTMLDetailsElement} */ (menu).open = false;
  };
  const navIsOpen = () => Boolean(navOverflow?.classList.contains("is-open"));
  navToggle?.addEventListener("click", () => setNavOpen(!navIsOpen()));
  navOverflow?.addEventListener("click", (event) => {
    const target = /** @type {Element} */ (event.target);
    // Switching view (Causes | Consequences, Graph | Table) shows the result at once.
    if (target.closest?.(".task-bar-view-controls button")) return setNavOpen(false);
    const item = target.closest?.(".menu-item, #taskReset");
    if (!item || item.matches("[data-keep-open], .file-button, .edit-history-entry")) return;
    setNavOpen(false);
  });
  navOverflow?.addEventListener("change", (event) => {
    const target = /** @type {HTMLInputElement} */ (event.target);
    if (target.type === "file" || target.id === "groupingSetSelect") setNavOpen(false);
  });
  window.matchMedia("(min-width: 961px)").addEventListener("change", () => setNavOpen(false));

  // Dropdown menus (Filters, task bar menus) close on an outside click or Escape.
  const openMenus = () => document.querySelectorAll("details.filter-dropdown[open], details.nav-menu[open], details.list-filter[open]");
  document.addEventListener("pointerdown", (event) => {
    const target = /** @type {Node} */ (event.target);
    if (navIsOpen() && !navOverflow?.contains(target) && !navToggle?.contains(target)) setNavOpen(false);
    for (const menu of openMenus()) {
      if (!menu.contains(target)) menu.open = false;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const menus = openMenus();
    for (const menu of menus) {
      menu.open = false;
      menu.querySelector("summary")?.focus();
    }
    // Escape closes an open menu inside the panel first, then the panel itself.
    if (!menus.length && navIsOpen()) {
      setNavOpen(false);
      navToggle?.focus();
    }
  });

  // Escape steps back to the previous screen when one exists: the previous step
  // of the create-a-variable wizard (Choose concepts → Describe → Start from → out),
  // or from evidence back to the graph in Explore. It only acts when nothing else
  // claimed the key: an open menu, dialog, context menu or full-screen panel
  // closes first (checked before their handlers run), and a component that
  // handled Escape itself calls preventDefault.
  const shown = (/** @type {HTMLElement | null} */ el) => Boolean(el && !el.hidden && el.getClientRects().length);
  const backControls = [
    () => els.definitionBack,
    () => els.definitionDescribeBack,
    // Leaving the wizard from its first step discards nothing typed elsewhere.
    () => shown(els.definitionSourcesStep) || shown(els.definitionDescribeStep) ? els.definitionCancel : null,
    () => els.customVariablesClose,
    () => state.task ? els.closeEvidencePane : null,
  ];
  let escapeClaimed = false;
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    escapeClaimed = Boolean(openMenus().length || navIsOpen() || document.querySelector("dialog[open]")
      || state.fullscreenPanel);
  }, { capture: true });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || escapeClaimed || event.defaultPrevented) return;
    const back = backControls.map(control => control()).find(shown);
    if (!back) return;
    event.preventDefault();
    back.click();
  });

  // Export / import
  els.exportProject.addEventListener("click", exportProject);
  els.exportWorkingMap.addEventListener("click", exportWorkingMap);
  els.projectImport.addEventListener("change", importProject);
  els.exportBib.addEventListener("click", exportBib);
  els.exportMd.addEventListener("click", exportMd);
  els.exportTex.addEventListener("click", exportTex);

  // A window drag fires resize continuously and each renderDag() restarts layout. Render once the resizing
  // settles, so the final size is always the one drawn.
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (state.project) renderDag();
    }, 120);
  });
  installDagHandlers();
  initPanelResizers();
}

  return { installHandlers };
}
