import { dagDataSource } from "./dag_data_source.mjs?v=browser-v2";
import { schemaPublicationId } from "./dag_data_config.mjs";
import { applyPermalink, permalinkInput, TASKS } from "./dag_permalink.mjs";
import { createProjectBootstrapPresenter } from "./project_bootstrap_presenter.mjs";
import { loadLocalSchema } from "./local_schema_store.mjs";
import { incrementCompiledDag } from "./compiled_dag.mjs";
import { normalizeLinkDecision } from "./dag_link_aggregation.mjs";
import { validateGroupingSchema } from "./data_validation.mjs";

export function createProjectBootstrap({ state, initElements, installHandlers, installDefinitionHandlers,
  initializeProject, loadLatestSchemaGroups,
  normalizeProjectDuplicateAssignments, publicationController, renderAll,
  dagNetworkController, buildDuplicateClusters,
  linkKey, pairKey, loadVariableSearchCatalog = async () => {}, onReady = () => {},
  onLocalSchemaLoaded = () => {}, waitForReadyBeforeShowing = () => false }) {
  const presenter = createProjectBootstrapPresenter({});
  const setStartupStage = message => presenter.setStartupStage(message);
  const finishStartupLoading = () => presenter.finishStartupLoading();

  async function init() {
    const waitForReady = waitForReadyBeforeShowing();
    dagDataSource.onStatus = setStartupStage;
    presenter.configureInterface(state.interfaceMode);
    initElements();
    installHandlers();
    installDefinitionHandlers();
    const requested = new URL(window.location.href);
    // A plain ?task= link opens that task directly; permalinks carry their own.
    const requestedTask = requested.searchParams.get("task");
    if (requested.searchParams.has("new")) {
      history.replaceState(null, "", requested.pathname);
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
    let applyDraftEdges = null;
    if (localRecord) {
      // The incident-link query below needs the evidence engine. Start it now so
      // it runs in the background while the first graph paints.
      void dagDataSource.ensureEvidenceConnection({ variableIds: [] }).catch(() => {});
      const publishedSchema = state.data.grouping_sets?.[0];
      const loadComplete = state.data.load_published_schema;
      const local = localRecord.schema;
      const publishedDag = state.data.compiled_dag;
      // Paint with the published edges and the draft's groups first. The draft's
      // edge changes need the complete schema and evidence queries (seconds), so
      // they are applied after the first render.
      const withDecisions = edges => edges.map(edge => {
        const decision = normalizeLinkDecision(local.link_decisions?.[edge.edge_id]) || null;
        return { ...edge, display_status: decision?.display_status || "active_by_default",
          user_decision: decision };
      });
      const nodeById = new Map((publishedDag?.nodes || []).map(node => [node.group_id, node]));
      const compiled = { ...publishedDag, edges: withDecisions(publishedDag?.edges || []), nodes: (local.groups || []).map(group => ({
        ...(nodeById.get(group.group_id) || {}), group_id: group.group_id, label: group.label || "",
        member_count: (group.variable_ids || []).length })) };
      state.data = { ...state.data, grouping_sets: [local],
        default_grouping_set_id: local.grouping_set_id,
        compiled_dag: compiled, load_published_schema: null };
      state.compiledDag = compiled;
      state.compiledDagValid = true;
      state.compiledDagUpdating = true;
      onLocalSchemaLoaded(localRecord);
      applyDraftEdges = async () => {
        const revision = state.compiledDagRevision || 0;
        const draftStart = performance.now();
        try {
          const complete = await loadComplete?.();
          performance.measure("echo:draft:published-schema", { start: draftStart, end: performance.now() });
          const base = complete?.schema || publishedSchema;
          const compute = performance.now();
          const owners = schema => new Map((schema.groups || []).flatMap(group =>
            (group.variable_ids || []).map(id => [id, group.group_id])));
          const before = owners(base), after = owners(local);
          const changed = [...new Set([...before.keys(), ...after.keys()])]
            .filter(id => before.get(id) !== after.get(id));
          const findingIds = [...new Set([...Object.keys(base.finding_decisions || {}),
            ...Object.keys(local.finding_decisions || {})])].filter(id =>
            (base.finding_decisions?.[id]?.display_status === "excluded")
              !== (local.finding_decisions?.[id]?.display_status === "excluded"));
          performance.measure("echo:draft:diff", { start: compute, end: performance.now() });
          const queryStart = performance.now();
          const incidentRawLinks = [...new Map((await Promise.all([
            changed.length ? dagDataSource.loadIncidentRawLinks(changed) : [],
            findingIds.length ? dagDataSource.loadRawLinksByIds(findingIds) : [],
          ])).flat().map(link => [link.raw_causal_link_id, link])).values()];
          performance.measure("echo:draft:links", { start: queryStart, end: performance.now() });
          if ((state.compiledDagRevision || 0) !== revision) {
            // An edit landed first; its incremental update assumed the draft's edges.
            state.compiledDagValid = false;
            return;
          }
          const incrementStart = performance.now();
          const incremented = incrementCompiledDag({
            compiledDag: publishedDag, oldSchema: base, newSchema: local, incidentRawLinks,
            project: { groups: local.groups, iv_group_id: permalink.get("iv"),
              dv_group_id: permalink.get("dv"), link_decisions: local.link_decisions || {},
              finding_decisions: local.finding_decisions || {} },
          });
          const edges = withDecisions(incremented.edges || []);
          const next = { ...incremented, edges };
          performance.measure("echo:draft:increment", { start: incrementStart, end: performance.now() });
          state.data = { ...state.data, compiled_dag: next };
          state.compiledDag = next;
          state.compiledDagUpdating = false;
          renderAll();
        } catch (error) {
          console.warn("Could not apply the draft's edge changes; a full local recomputation is required.", error);
          state.compiledDagValid = false;
        } finally {
          state.compiledDagUpdating = false;
          if (state.compiledDagUpdatePromise === draftPromise) state.compiledDagUpdatePromise = null;
          performance.measure("echo:draft:total", { start: draftStart, end: performance.now() });
        }
      };
    }
    let draftPromise = null;
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
    state.project.finding_decisions = structuredClone((localRecord?.schema
      || state.data.grouping_sets?.[0])?.finding_decisions || {});
    state.project.confounder_statuses = structuredClone((localRecord?.schema
      || state.data.grouping_sets?.[0])?.confounder_statuses || {});
    state.project.collider_statuses = structuredClone((localRecord?.schema
      || state.data.grouping_sets?.[0])?.collider_statuses || {});
    state.project.exclusion_statuses = structuredClone((localRecord?.schema
      || state.data.grouping_sets?.[0])?.exclusion_statuses || {});
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
    } else if (TASKS.includes(requestedTask)) state.task = requestedTask;
    // A new project, or a link that names no task, opens the start page (state.task stays null).
    if (state.data.publication_source && !state.project.publication) {
      state.project.publication = {
        ...state.data.publication_source,
        permalink: new URL(`?schema=${state.data.publication_source.publication_id}`, new URL(window.location.pathname, window.location.origin)).href,
      };
    }
    if (localRecord?.lastPublishedId) {
      state.project.publication = {
        publication_id: localRecord.lastPublishedId,
        content_hash: localRecord.lastPublishedHash,
        permalink: new URL(`?schema=${localRecord.lastPublishedId}`, new URL(window.location.pathname, window.location.origin)).href,
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
    // Started before the frame wait: requestAnimationFrame stalls in hidden tabs.
    if (applyDraftEdges) {
      draftPromise = applyDraftEdges();
      state.compiledDagUpdatePromise = draftPromise;
    }
    if (state.permalinkDagViewport) {
      dagNetworkController.getNetwork()?.moveTo({ ...state.permalinkDagViewport, animation: false });
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!waitForReady) finishStartupLoading();
    else setStartupStage("Restoring your variable…");
    const ready = async () => {
      try { await onReady(); }
      finally { if (waitForReady) finishStartupLoading(); }
    };
    // The first evidence panel otherwise pays for query-engine startup (WASM
    // instantiation and snapshot validation, over a second). Start it once the
    // schema work is done, in idle time, unless the snapshot has evidence bundles
    // (which never need it) or the user asked to save data.
    const prewarmEvidenceEngine = () => Promise.resolve(dagDataSource.bindViewerAssets?.()).then(() => new Promise(resolve => {
      // Startup has already painted. Warm the engine in idle time even when
      // the start page is showing, so the first evidence click is ready.
      if (globalThis.navigator?.connection?.saveData || dagDataSource.hasEvidencePanelBundles()) { resolve(); return; }
      const start = () => void dagDataSource.ensureEvidenceConnection({ variableIds: [] }).catch(() => {}).finally(resolve);
      if (typeof globalThis.requestIdleCallback === "function") globalThis.requestIdleCallback(start, { timeout: 5000 });
      else setTimeout(start, 1000);
    }));
    const preload = () => void prewarmEvidenceEngine();
    // A fresh project carries placeholder anchor IDs, so check for real groups.
    const anchored = side => (state.project.groups || []).some(group => group.group_id === state.project[`${side}_group_id`]);
    const catalogIfSettingUp = () => (!anchored("iv") || !anchored("dv")
      ? loadVariableSearchCatalog() : Promise.resolve());
    // Keep membership loading ahead of the search index; start warming the
    // catalog after hydration so subsequent searches are ready during setup.
    if (state.data.load_published_schema) {
      const revision = state.compiledDagRevision || 0;
      const applyLoadedSchema = async (schema, complete = false) => {
        state.data.grouping_sets = [schema];
        state.data.default_grouping_set_id = schema.grouping_set_id;
        state.project.link_decisions = structuredClone(schema.link_decisions || {});
        state.project.finding_decisions = structuredClone(schema.finding_decisions || {});
        state.project.confounder_statuses = structuredClone(schema.confounder_statuses || {});
        state.project.collider_statuses = structuredClone(schema.collider_statuses || {});
        state.project.exclusion_statuses = structuredClone(schema.exclusion_statuses || {});
        loadLatestSchemaGroups();
        normalizeProjectDuplicateAssignments();
        // Membership hydration and the following DOM/canvas refresh are
        // separate stages. Let input and painting run between them.
        await new Promise(resolve => setTimeout(resolve, 0));
        if (complete) {
          state.publishedSchemaHydrating = false;
          state.publishedSchemaHydrated = true;
        }
        // Compiled nodes and routes already describe this publication. Hydrating
        // memberships updates controls and metadata without changing geometry.
        // The landing page covers the workspace. Its first paint is already
        // complete, and choosing a task renders the hydrated workspace then.
        if (state.task) renderAll({ reuseDagGeometry: true });
      };
      void state.data.load_published_schema({ onPriorityReady: ({ schema, groupIds }) => {
        if ((state.compiledDagRevision || 0) !== revision) return;
        state.publishedMembershipReadyGroups = new Set(groupIds);
        return applyLoadedSchema(schema);
      } }).then(async ({ schema }) => {
        if ((state.compiledDagRevision || 0) !== revision) return;
        state.publishedMembershipReadyGroups = new Set(schema.groups.map(group => group.group_id));
        state.publishedSchemaLoadFailed = false;
        await applyLoadedSchema(schema, true);
        void catalogIfSettingUp();
        publicationController.setSchemaReady?.(true);
        void publicationController.refreshPublicationState?.();
        await ready();
        preload();
      }).catch(error => {
        if ((state.compiledDagRevision || 0) !== revision) return;
        state.publishedSchemaHydrating = false;
        state.publishedSchemaLoadFailed = true;
        publicationController.setSchemaLoadFailed?.();
        console.error("Could not finish loading the published schema.", error);
        if (waitForReady) finishStartupLoading();
        preload();
      });
    } else {
      void catalogIfSettingUp();
      await ready();
      preload();
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
    state.edgeSupportById = new Map();
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
