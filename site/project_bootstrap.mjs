import { dagDataSource } from "./dag_data_source.mjs?v=browser-v2";
import { schemaPublicationId } from "./dag_data_config.mjs";
import { applyPermalink, permalinkInput } from "./dag_permalink.mjs";
import { createProjectBootstrapPresenter } from "./project_bootstrap_presenter.mjs";
import { loadLocalSchema } from "./local_schema_store.mjs";
import { incrementCompiledDag } from "./compiled_dag.mjs";
import { normalizeLinkDecision } from "./dag_link_aggregation.mjs";
import { validateGroupingSchema } from "./data_validation.mjs";

export function createProjectBootstrap({ state, initElements, installHandlers, installDefinitionHandlers,
  resizeMap, initializeProject, loadLatestSchemaGroups,
  normalizeProjectDuplicateAssignments, publicationController, renderAll,
  constrainMapTransform, drawMap, fitMap, dagNetworkController, buildDuplicateClusters,
  linkKey, pairKey, loadVariableSearchCatalog = async () => {}, onReady = () => {},
  onLocalSchemaLoaded = () => {} }) {
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
    const requested = new URL(window.location.href);
    if (requested.searchParams.has("new")) {
      history.replaceState(null, "", "/");
    } else if (requested.pathname === "/" && !requested.search && !requested.hash) {
      history.replaceState(null, "", requested.href);
    }
    const permalink = permalinkInput();
    const localId = permalink?.get("local_schema") || "";
    const localRecord = localId ? await loadLocalSchema(localId) : null;
    if (localId && (!localRecord || !localRecord.schema?.groups)) {
      throw new Error("Local schema unavailable. This URL needs a draft stored in this browser. Import a draft or open a published view.");
    }
    if (localRecord) validateGroupingSchema(localRecord.schema);
    const publicationId = schemaPublicationId();
    if (localRecord && (!permalink.get("schema")
      || localRecord.basePublicationId !== publicationId)) {
      throw new Error("Local schema does not match the published base in this URL.");
    }
    const dataStart = performance.now();
    await loadDagData(permalink?.get("vlayout") || "");
    performance.measure("echo:startup:data", { start: dataStart, end: performance.now() });
    if (localRecord) {
      const publishedSchema = state.data.grouping_sets?.[0];
      const complete = await state.data.load_published_schema?.();
      const base = complete?.schema || publishedSchema;
      const local = localRecord.schema;
      const owners = schema => new Map((schema.groups || []).flatMap(group =>
        (group.variable_ids || []).map(id => [id, group.group_id])));
      const before = owners(base), after = owners(local);
      const changed = [...new Set([...before.keys(), ...after.keys()])]
        .filter(id => before.get(id) !== after.get(id));
      const incidentRawLinks = changed.length ? await dagDataSource.loadIncidentRawLinks(changed) : [];
      const incremented = incrementCompiledDag({
        compiledDag: state.data.compiled_dag, oldSchema: base, newSchema: local,
        incidentRawLinks,
        project: { groups: local.groups, iv_group_id: permalink.get("iv"),
          dv_group_id: permalink.get("dv"), link_decisions: local.link_decisions || {} },
      });
      const compiled = { ...incremented, edges: (incremented.edges || []).map(edge => {
        const decision = normalizeLinkDecision(local.link_decisions?.[edge.edge_id]) || null;
        return { ...edge, display_status: decision?.display_status || "active_by_default",
          user_decision: decision };
      }) };
      state.data = { ...state.data, grouping_sets: [local],
        default_grouping_set_id: local.grouping_set_id,
        compiled_dag: compiled, load_published_schema: null };
      state.compiledDag = compiled;
      state.compiledDagValid = true;
      onLocalSchemaLoaded(localRecord);
    }
    if (state.data.load_published_schema) {
      state.publishedSchemaHydrating = true;
      state.publishedSchemaHydrated = false;
      state.publishedSchemaLoadFailed = false;
      state.publishedMembershipReadyGroups = new Set();
      publicationController.setSchemaReady?.(false);
    }
    state.selectedUoa = null;
    state.uoaFilterEnabled = false;
    setStartupStage("Preparing workspace…");
    initializeProject();
    loadLatestSchemaGroups();
    state.project.link_decisions = structuredClone((localRecord?.schema
      || state.data.grouping_sets?.[0])?.link_decisions || {});
    normalizeProjectDuplicateAssignments();
    if (state.interfaceMode === "dag2") {
      state.phase = "select_iv";
      state.workflowMode = "setup";
      state.selectedUoa = null;
      state.uoaFilterEnabled = false;
    }
    if (permalink) {
      applyPermalink(permalink, state);
      if (state.project.iv_group_id && state.project.dv_group_id) state.phase = "build";
    }
    if (state.data.publication_source && !state.project.publication) {
      state.project.publication = {
        ...state.data.publication_source,
        permalink: new URL(`/?schema=${state.data.publication_source.publication_id}`, window.location.origin).href,
      };
    }
    if (localRecord?.lastPublishedId) {
      state.project.publication = {
        publication_id: localRecord.lastPublishedId,
        content_hash: localRecord.lastPublishedHash,
        permalink: new URL(`/?schema=${localRecord.lastPublishedId}`, window.location.origin).href,
      };
    }
    if (state.interfaceMode === "dag2") publicationController.initialize();
    const restoredLayoutSource = state.variableLayoutSource;
    if (restoredLayoutSource && restoredLayoutSource !== state.data.layout?.active_source) {
      await loadDagData(restoredLayoutSource);
    }
    setStartupStage("Rendering graph…");
    const renderStart = performance.now();
    renderAll();
    await dagNetworkController.whenRendered?.();
    performance.measure("echo:startup:graph", { start: renderStart, end: performance.now() });
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
    // The large variable catalog is loaded when someone searches for the
    // first time. Group-label browsing does not need it at startup.
    if (state.data.load_published_schema) {
      const revision = state.compiledDagRevision || 0;
      const applyLoadedSchema = schema => {
        state.data.grouping_sets = [schema];
        state.data.default_grouping_set_id = schema.grouping_set_id;
        state.project.link_decisions = structuredClone(schema.link_decisions || {});
        loadLatestSchemaGroups();
        normalizeProjectDuplicateAssignments();
        // Compiled nodes and routes already describe this publication. Hydrating
        // memberships updates controls and metadata without changing geometry.
        renderAll({ reuseDagGeometry: true });
      };
      void state.data.load_published_schema({ onPriorityReady: ({ schema, groupIds }) => {
        if ((state.compiledDagRevision || 0) !== revision) return;
        state.publishedMembershipReadyGroups = new Set(groupIds);
        applyLoadedSchema(schema);
      } }).then(({ schema }) => {
        if ((state.compiledDagRevision || 0) !== revision) return;
        state.publishedMembershipReadyGroups = new Set(schema.groups.map(group => group.group_id));
        state.publishedSchemaHydrating = false;
        state.publishedSchemaHydrated = true;
        state.publishedSchemaLoadFailed = false;
        applyLoadedSchema(schema);
        publicationController.setSchemaReady?.(true);
        void publicationController.refreshPublicationState?.();
        onReady();
      }).catch(error => {
        if ((state.compiledDagRevision || 0) !== revision) return;
        state.publishedSchemaHydrating = false;
        state.publishedSchemaLoadFailed = true;
        publicationController.setSchemaLoadFailed?.();
        console.error("Could not finish loading the published schema.", error);
      });
    } else {
      onReady();
    }
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
