import { dagDataSource } from "./dag_data_source.mjs";
import { schemaPublicationId } from "./dag_data_config.mjs";
import { applyPermalink, permalinkInput } from "./dag_permalink.mjs";
import { createProjectBootstrapPresenter } from "./project_bootstrap_presenter.mjs";

export function createProjectBootstrap({ state, initElements, installHandlers, installDefinitionHandlers,
  resizeMap, restoreProjectLocally, initializeProject, loadLatestSchemaGroups,
  normalizeProjectDuplicateAssignments, saveProjectLocally, publicationController, renderAll,
  constrainMapTransform, drawMap, fitMap, dagNetworkController, buildDuplicateClusters,
  linkKey, pairKey }) {
  const presenter = createProjectBootstrapPresenter({});
  const setStartupStage = message => presenter.setStartupStage(message);
  const finishStartupLoading = () => presenter.finishStartupLoading();

  async function init() {
    dagDataSource.onStatus = setStartupStage;
    presenter.configureInterface(state.interfaceMode);
    initElements();
    installHandlers();
    installDefinitionHandlers();
    resizeMap();
    const permalink = permalinkInput();
    const publicationId = schemaPublicationId();
    await loadDagData(permalink?.get("vlayout") || "");
    setStartupStage("Preparing workspace…");
    const restored = permalink || publicationId ? false : restoreProjectLocally();
    if (restored && state.definitionDraft && state.interfaceMode === "dag2"
        && !presenter.confirmResumeDefinition()) {
      state.definitionDraft = null;
      saveProjectLocally();
    }
    if (!restored) {
      initializeProject();
      loadLatestSchemaGroups();
      normalizeProjectDuplicateAssignments();
      if (state.interfaceMode === "dag2") {
        state.phase = "select_iv";
        state.workflowMode = "setup";
        state.selectedUoa = null;
        state.uoaFilterEnabled = false;
        state.filterDagByCausalRelevance = false;
      }
      if (permalink) {
        applyPermalink(permalink, state);
        state.phase = "build";
      }
    }
    if (state.data.publication_source && !state.project.publication) {
      state.project.publication = {
        ...state.data.publication_source,
        permalink: new URL(`/?schema=${state.data.publication_source.publication_id}`, window.location.origin).href,
      };
    }
    if (state.interfaceMode === "dag2") publicationController.initialize();
    const restoredLayoutSource = state.variableLayoutSource;
    if (restoredLayoutSource && restoredLayoutSource !== state.data.layout?.active_source) {
      await loadDagData(restoredLayoutSource);
    }
    setStartupStage("Rendering graph…");
    renderAll();
    if (state.permalinkMapViewport) {
      constrainMapTransform();
      drawMap();
    } else {
      fitMap();
    }
    if (state.permalinkDagViewport) {
      dagNetworkController.getNetwork()?.moveTo({ ...state.permalinkDagViewport, animation: false });
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    finishStartupLoading();
  }

  async function loadDagData(layoutSource = "") {
    state.data = await dagDataSource.load(layoutSource);
    state.variables = (state.data.variables || []).slice().sort((a, b) => a.index - b.index);
    if (state.projectStorageVariableCount === null) {
      state.projectStorageVariableCount = Number(state.data.project_storage_variable_count || state.variables.length);
    }
    state.variableLayoutSource = state.data.layout?.active_source || layoutSource || "";
    state.variableById = new Map(state.variables.map((v) => [v.variable_id, v]));
    buildDuplicateClusters();
    state.rawLinks = state.data.raw_causal_links || [];
    state.compiledDag = state.data.compiled_dag || null;
    state.compiledDagValid = Boolean(state.compiledDag);
    state.rawLinksById = new Map(state.rawLinks.map((l) => [l.raw_causal_link_id, l]));
    state.linkLookup = new Map();
    for (const link of state.rawLinks) {
      const key = linkKey(link.source_variable_id, link.target_variable_id);
      if (!state.linkLookup.has(key)) state.linkLookup.set(key, []);
      state.linkLookup.get(key).push(link.raw_causal_link_id);
    }
    state.similarityEdgeMap = new Map();
    for (const edge of state.data.similarity_edges || []) {
      state.similarityEdgeMap.set(pairKey(edge.source, edge.target), Number(edge.weight || 0));
    }
    if (state.project) normalizeProjectDuplicateAssignments();
  }

  return { init, loadDagData, setStartupStage, finishStartupLoading };
}
