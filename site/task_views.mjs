import { h, replaceChildren } from "./dom_builder.mjs";
import { causalNeighborhood, MAX_NEIGHBORHOOD_DEPTH } from "./causal_neighborhood.mjs";
import { createVariableButton, customVariableActions } from "./custom_variable_actions.mjs";
import { pathView } from "./dag_table.mjs";

const TASK_CLASSES = { identify: "task-identify", causes: "task-causes", consequences: "task-consequences" };
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const EXPLORE_NAV_LABELS = { controls: "Variables view", dag: "Map view" };
const IDENTIFY_SIDES = ["iv", "dv", "instrument"];
const IDENTIFY_FIELD_NAMES = { iv: "cause", dv: "outcome", instrument: "instrument" };
// What each Identify diagnostic lists, and where its candidates and witness paths live in the state.
const IDENTIFY_VIEWS = {
  confounders: { ids: "confounderGroupIds", paths: "confounderPathsByGroup", noun: "confounders" },
  colliders: { ids: "colliderGroupIds", paths: "colliderPathsByGroup", noun: "colliders" },
  exclusion: { ids: "exclusionViolationIds", paths: "exclusionPathsByGroup", noun: "exclusion restriction violations" },
  exogeneity: { ids: "exogeneityGroupIds", paths: "exogeneityPathsByGroup", noun: "common causes of the instrument and outcome" },
};
/** The routes behind an Identify candidate, each a list of group ids in causal order. */
function witnessRoutes(stored) {
  if (!stored) return [];
  if (Array.isArray(stored)) return stored.length > 1 ? [stored] : [];
  return Object.values(stored).filter(path => Array.isArray(path) && path.length > 1);
}
// The Identify panel's filter choices.
const IDENTIFY_KINDS = [
  ["all", "All", "List every variable"],
  ["confounders", "Confounders", "Only variables that could cause both the cause and the outcome"],
  ["colliders", "Colliders", "Only variables that both the cause and the outcome could cause"],
];
const IDENTIFY_DEFAULTS = { confounderMaxPathLength: 1, excludeSparseEdges: false, minimumEdgePapers: 2 };
const SVG_NS = "http://www.w3.org/2000/svg";
/** The Lucide funnel ("filter") icon, built as DOM nodes. */
function filterIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [name, value] of Object.entries({ class: "lucide", width: "16", height: "16", viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
    svg.setAttribute(name, value);
  }
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z");
  svg.append(path);
  return svg;
}
const MAP_ICON_PATHS = [
  "M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z",
  "M15 5.764v15", "M9 3.236v15"];
/** The Lucide map icon, built as DOM nodes. */
function mapIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [name, value] of Object.entries({ class: "lucide", width: "16", height: "16", viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(name, value);
  for (const d of MAP_ICON_PATHS) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
function backToMapLabel() {
  const label = document.createElement("span");
  label.textContent = "Back to map";
  return label;
}
const clampDepth = value => Math.max(1, Math.min(MAX_NEIGHBORHOOD_DEPTH, Math.trunc(Number(value)) || 1));

/** A fresh project on the same published schema and evidence, opening in Exploration. */
export function freshProjectUrl(href) {
  const current = new URL(href);
  const fresh = new URL(current.pathname, current.origin);
  for (const key of ["schema", "data_version", "evidence_manifest", "schema_source"]) {
    if (current.searchParams.has(key)) fresh.searchParams.set(key, current.searchParams.get(key));
  }
  return fresh.href;
}

/**
 * The graph for a neighborhood: the variables found plus the focus, and one
 * link per hop on the chosen routes. Links are the project's own (so evidence
 * and selection work as in Identify) with their direction narrowed to the hop
 * that qualified, so an arrow never contradicts the list.
 */
export function neighborhoodGraph({ rows, focusId, links, direction = "causes" }) {
  const byId = new Map(links.map(link => [link.edge_id, link]));
  const groupIds = new Set(focusId ? [focusId] : []);
  const hops = new Map();
  for (const row of rows) {
    for (const id of row.path) groupIds.add(id);
    row.pathEdgeIds.forEach((edgeId, index) => {
      // Edge IDs follow causal order: path[index] is the cause, path[index + 1] the effect.
      hops.set(edgeId, { from: row.path[index], to: row.path[index + 1] });
    });
  }
  const visible = [];
  for (const [edgeId, { from, to }] of hops) {
    const link = byId.get(edgeId);
    if (link) visible.push({ ...link, direction_type: link.group_a === from ? "A_TO_B" : "B_TO_A" });
  }
  // Layout hints: the variables by distance, and each one's neighbour toward the focus.
  const layout = focusId ? {
    id: focusId,
    order: rows.map(row => row.groupId),
    distance: rows.map(row => [row.groupId, row.distance]),
    parent: rows.map(row => [row.groupId, direction === "causes" ? row.path[1] : row.path[row.path.length - 2]]),
  } : null;
  return { groupIds, links: visible, layout };
}

// The task bar, the identification and exploration views, and Reset.
// Causes and consequences share the Identify workspace: the list and controls
// replace the left panel, and the graph and the evidence for a clicked link use
// the same network and evidence pane Identify uses.
export function createTaskViews({ state, searchGroups, searchStatus = () => "ready", onChange = () => {},
  paperSupport = () => ({ status: "ready", papersFor: undefined }), loadPaperSupport = () => {},
  isDisplayGroup = () => true, onExploreChange = () => {}, onTaskChange = () => {},
  onFocusPicking = () => {}, onPickerInput = () => {}, onSetupNeeded = () => {}, openEvidence = () => {},
  onRowHover = () => {}, onChooseIdentify = () => {}, onIdentifyPicking = () => {}, onIdentifyRowHover = () => {},
  onIdentifyExcludedChange = () => {}, onOpenIdentifyVariable = () => {}, canChangeCustom = () => true, onEditCustom = () => {}, onDeleteCustom = async () => {}, onCreateCustom = () => {},
  placeEvidencePane = () => {}, prepareReset = () => {}, whenReady = () => Promise.resolve(), openWindow = (url) => window.open(url, "_blank", "noopener"),
  navigate = (url) => window.location.assign(url) }) {
  const el = id => document.getElementById(id);
  const els = {
    bar: el("taskBar"), reset: el("taskReset"), direction: el("exploreDirection"), landing: el("taskLanding"), explore: el("exploreView"),
    resultsBlock: el("exploreResultsBlock"), summary: el("exploreSummary"),
    results: el("exploreResults"), dialog: el("resetDialog"), graphHint: el("exploreGraphHint"),
    graphTitle: el("dagViewTitle"), focusInput: el("focusInput"), focusClear: el("focusClear"), pickerCancel: el("focusPickerCancel"),
    pathLabel: el("confounderPathLengthLabel"), pathInput: el("confounderPathLength"),
  };
  // Whether the user asked to change the focus; not part of the saved view.
  const changing = { causes: false, consequences: false };
  // The evidence open in each task, so switching tasks keeps what you were reading.
  const selections = { identify: null, causes: null, consequences: null };
  // Identify's own filter settings while an explore view uses the same controls.
  let identifySettings = null;
  let settingsTask = null;
  // Paper counts per link direction, reused until the links or support change.
  let countCache = { key: null, counts: new Map() };
  let hoodCache = { key: null, value: null };
  // Causes and consequences are one Explore view with a direction toggle; the
  // Explore tab reopens whichever direction was last shown.
  let lastDirection = "causes";
  // The list's own filter: whether its menu is open and the name being searched.
  // The search narrows the list only; the paper minimum is the view's setting, so it shapes the graph too.
  const listFilter = { open: false, query: "" };
  // The Identify field being searched (iv, dv or instrument); not part of the saved view.
  let identifyPicking = null;
  let identifyListKey = null;
  // The Identify panel's filter: "all", "confounders" or "colliders"; not part of the saved view.
  let identifyKind = "all";

  const exploring = () => state.task === "causes" || state.task === "consequences";
  const view = () => state.explore[state.task];
  const groups = () => state.project?.groups || [];
  const groupFor = id => groups().find(group => group.group_id === id);
  const labelFor = id => groupFor(id)?.label || id;
  const focusId = () => (groupFor(view().focusId) ? view().focusId : null);
  // Variables the user unticked: listed, but left off the map and not followed further.
  const excludedIds = () => new Set(view().excluded || []);
  const anchorConfigured = side => {
    const group = groupFor(state.project?.[`${side}_group_id`]);
    return Boolean(group?.variable_ids?.length
      || (state.publishedSchemaHydrating && Number(group?.member_count) > 0));
  };

  function cachedCounter(support) {
    const links = state.project?.links || [];
    const key = [links, support.status, support.cacheKey, support.cacheKey?.size];
    if (!countCache.key || key.some((part, index) => part !== countCache.key[index])) {
      countCache = { key, counts: new Map() };
    }
    const { counts } = countCache;
    return (link, forward) => {
      const id = `${link.edge_id}\u0000${forward ? 1 : 0}`;
      if (!counts.has(id)) counts.set(id, support.papersFor(link, forward));
      return counts.get(id);
    };
  }

  /**
   * The list rows and graph for the current view, shared by the list and the
   * graph and reused until the links, support or settings change.
   */
  function neighborhood() {
    const focus = exploring() ? focusId() : null;
    const empty = { rows: [], included: [], graph: { groupIds: new Set(), links: [], layout: null } };
    if (!focus) return { status: "none", ...empty };
    const support = paperSupport();
    if (support.status === "loading") return { status: "loading", ...empty };
    const { depth, minPapers } = settings();
    const links = state.project?.links || [];
    const excluded = excludedIds();
    const key = [state.task, focus, depth, minPapers, links, links.length, groups(), support.status, support.cacheKey,
      support.cacheKey?.size, [...excluded].sort().join("\u0000")];
    if (hoodCache.key && key.every((part, index) => part === hoodCache.key[index])) return hoodCache.value;
    const hidden = new Set(groups().filter(group => !isDisplayGroup(group)).map(group => group.group_id));
    const rows = causalNeighborhood({ links, focusId: focus, direction: state.task, depth, minPapers,
      papersFor: support.papersFor && cachedCounter(support), isNode: id => !hidden.has(id),
      isPassable: id => !excluded.has(id) })
      .map(row => ({ ...row, excluded: excluded.has(row.groupId) }));
    const included = rows.filter(row => !row.excluded);
    const value = { status: support.status, rows, included,
      graph: neighborhoodGraph({ rows: included, focusId: focus, links, direction: state.task }) };
    hoodCache = { key, value };
    return value;
  }

  const focusMeta = () => state.task === "causes" ? { side: "dv", tag: "Dep var" } : { side: "iv", tag: "Ind var" };

  /** What the shared anchor bar and picker need to show for the one variable. */
  function focus() {
    if (!exploring()) return { active: false };
    const id = focusId();
    return { active: true, ...focusMeta(), groupId: id, label: id ? labelFor(id) : "", picking: !id || changing[state.task] };
  }

  function searchFocusGroups(query) {
    const hydrated = groups().some(group => group.variable_ids?.length);
    const available = groups().filter(group => (!hydrated || group.variable_ids?.length) && isDisplayGroup(group));
    return query ? searchGroups(available, query, Infinity)
      : available.map(group => ({ group, variableMatch: "" }));
  }

  // The existing Filters controls carry each view's distance and minimum papers
  // (Max path, Exclude sparse edges, Min papers); this keeps them per task.
  const sharedFromView = slot => ({ confounderMaxPathLength: clampDepth(slot.depth),
    excludeSparseEdges: slot.minPapers > 1, minimumEdgePapers: Math.max(2, slot.minPapers) });
  function settings() {
    if (state.confounderMaxPathLength !== clampDepth(state.confounderMaxPathLength)) {
      state.confounderMaxPathLength = clampDepth(state.confounderMaxPathLength);
    }
    const minPapers = state.excludeSparseEdges ? Math.max(1, Math.trunc(Number(state.minimumEdgePapers)) || 2) : 1;
    const current = { depth: state.confounderMaxPathLength, minPapers };
    // Mirror into the saved view so permalinks and the other tasks see it.
    Object.assign(view(), current);
    return current;
  }
  function adoptViewSettings() {
    settingsTask = state.task;
    Object.assign(state, sharedFromView(view()));
  }

  /** Remember each task's open evidence and filter settings, then restore the new task's. */
  function swapTask(previous, next) {
    if (previous === "identify") {
      identifySettings = { confounderMaxPathLength: state.confounderMaxPathLength,
        excludeSparseEdges: state.excludeSparseEdges, minimumEdgePapers: state.minimumEdgePapers };
    } else if (previous) settings();
    selections[previous || "identify"] = state.selectedEdgeId || null;
    state.selectedEdgeId = (next && selections[next]) || null;
    state.selectedEvidenceGroupId = null;
    state.task = next;
    if (next === "identify") Object.assign(state, identifySettings || (previous ? IDENTIFY_DEFAULTS : {}));
    else if (next) adoptViewSettings();
  }

  function showLanding() {
    if (!state.task) return;
    const previous = state.task;
    swapTask(previous, null);
    changing.causes = false;
    changing.consequences = false;
    identifyPicking = null;
    onTaskChange({ previous, task: null });
    render();
    onChange();
  }

  function setTask(requested) {
    const task = requested === "explore" ? (exploring() ? state.task : lastDirection) : requested;
    const needsSetup = () => task === "identify"
      ? !anchorConfigured("iv") || !anchorConfigured("dv")
      : !focusId();
    if (state.task === task) {
      if (needsSetup()) onSetupNeeded();
      return;
    }
    const previous = state.task;
    swapTask(previous, task);
    // The focus search input is shared by both explore views. A first visit
    // should start with the full picker, rather than another view's query.
    if ((task === "causes" || task === "consequences") && !focusId()) {
      els.focusInput.value = "";
    }
    // The shared workspace can be left in Groups by another task. An
    // unconfigured Identify view must begin at its anchor setup regardless of
    // which tab (or landing choice) opened it.
    if (task === "identify" && needsSetup()) {
      state.workflowMode = "setup";
      state.phase = anchorConfigured("iv") ? "select_dv" : "select_iv";
    }
    changing.causes = false;
    changing.consequences = false;
    onTaskChange({ previous, task });
    render();
    if (needsSetup()) onSetupNeeded();
    onChange();
  }

  /** Flip the Explore view between causes and consequences, keeping its variable and filters. */
  function setDirection(direction) {
    if (!exploring() || state.task === direction) return;
    const current = settings();
    const id = focusId();
    const target = state.explore[direction];
    Object.assign(target, current);
    if (id && target.focusId !== id) {
      target.focusId = id;
      delete target.excluded;
      selections[direction] = null;
    }
    setTask(direction);
  }

  function chooseFocus(groupId) {
    changing[state.task] = false;
    els.focusInput.value = labelFor(groupId);
    els.focusInput.blur();
    if (groupId !== view().focusId) {
      view().focusId = groupId;
      // Exclusions belong to the old neighborhood.
      delete view().excluded;
      // The open evidence belongs to the old neighborhood.
      state.selectedEdgeId = null;
    }
    onExploreChange();
    onChange();
  }

  function changeFocus() {
    changing[state.task] = true;
    // Start from the full list, not a search for the current variable's name.
    els.focusInput.value = "";
    onFocusPicking();
    els.focusInput.focus();
  }

  /** The × in the Primary variable field shows whenever there is something to clear. */
  function syncFocusClear() {
    if (els.focusClear) els.focusClear.hidden = !(exploring() && (els.focusInput.value || focusId()));
  }

  /** The × in the Primary variable field: drop the variable and go back to choosing one. */
  function clearFocus() {
    if (!exploring()) return;
    changing[state.task] = false;
    els.focusInput.value = "";
    if (view().focusId) {
      view().focusId = null;
      delete view().excluded;
      state.selectedEdgeId = null;
    }
    onExploreChange();
    onChange();
    syncFocusClear();
    els.focusInput.focus();
  }

  /** Close the variable dropdown and show the chosen variable again. */
  function cancelChange() {
    if (!exploring() || !changing[state.task]) return;
    changing[state.task] = false;
    els.focusInput.value = focusId() ? labelFor(focusId()) : "";
    onFocusPicking();
  }

  /** Include (true) or exclude (false) variables from the map, keeping keyboard focus on the box used. */
  function setIncluded(groupIds, include, focusSelector = null) {
    const excluded = excludedIds();
    for (const id of groupIds) {
      if (include) excluded.delete(id);
      else excluded.add(id);
    }
    if (excluded.size) view().excluded = [...excluded];
    else delete view().excluded;
    onExploreChange();
    onChange();
    if (focusSelector) els.results.querySelector(focusSelector)?.focus();
  }

  /** Hide list rows whose name does not match the search; the menu itself always stays. */
  function applyListSearch() {
    const query = listFilter.query.trim().toLowerCase();
    for (const group of els.results.querySelectorAll(".explore-group")) {
      let total = 0;
      let shown = 0;
      for (const row of group.querySelectorAll(".explore-row")) {
        const match = !query || row.querySelector(".explore-row-label").textContent.toLowerCase().includes(query);
        row.hidden = !match;
        total += 1;
        if (match) shown += 1;
      }
      // Both sections always show; an empty one says why.
      const empty = group.querySelector(".list-filter-empty");
      if (empty) {
        empty.hidden = shown > 0;
        empty.textContent = total ? "No variable in this section matches the search." : empty.dataset.empty;
      }
    }
    els.results.querySelector(".list-filter > summary")?.classList.toggle("is-active", Boolean(query));
  }

  /**
   * The funnel menu beside the first list heading: the one place Explore's filters live
   * (name search, distance, minimum papers per link, and any excluded links or findings).
   */
  function listFilterControl() {
    const { depth, minPapers } = settings();
    const search = h("input", { type: "search", className: "search-input list-filter-search", value: listFilter.query,
      placeholder: "Search these variables", autocomplete: "off",
      attrs: { "aria-label": "Search the listed variables" },
      oninput: event => { listFilter.query = event.target.value; clear.hidden = !listFilter.query; applyListSearch(); } });
    // A faint × over the field's right edge empties the search and keeps focus in the field.
    const clear = h("button", { type: "button", className: "list-filter-clear", textContent: "×", hidden: !listFilter.query,
      title: "Clear the search", attrs: { "aria-label": "Clear the search" },
      onclick: () => { search.value = ""; listFilter.query = ""; clear.hidden = true; applyListSearch(); search.focus(); } });
    const papers = h("input", { type: "number", className: "path-length-input list-filter-papers", min: 1, step: 1,
      value: String(minPapers), attrs: { inputmode: "numeric", "aria-label": "Minimum papers per link" },
      oninput: event => {
        const requested = Math.trunc(Number(event.target.value));
        if (!Number.isSafeInteger(requested) || requested < 1) return;
        // One paper means no minimum; the Filters menu keeps the same two settings.
        state.excludeSparseEdges = requested > 1;
        if (requested > 1) state.minimumEdgePapers = requested;
        onExploreChange();
        onChange();
        els.results.querySelector(".list-filter-papers")?.focus();
      },
      onchange: event => { event.target.value = String(settings().minPapers); } });
    const distance = h("input", { type: "number", className: "path-length-input list-filter-distance", min: 1,
      max: MAX_NEIGHBORHOOD_DEPTH, step: 1, value: String(depth),
      title: `How many causal steps from the variable to follow (1 to ${MAX_NEIGHBORHOOD_DEPTH}).`,
      attrs: { inputmode: "numeric", "aria-label": "Distance in causal steps" },
      oninput: event => {
        const requested = Math.trunc(Number(event.target.value));
        if (!Number.isSafeInteger(requested) || requested < 1) return;
        state.confounderMaxPathLength = clampDepth(requested);
        onExploreChange();
        onChange();
        els.results.querySelector(".list-filter-distance")?.focus();
      },
      onchange: event => { event.target.value = String(settings().depth); } });
    // Excluded links and findings open from the graph's Filters menu elsewhere; in Explore they open from here.
    const excludedActions = ["showExcludedLinks", "showExcludedFindings"].map(el)
      .filter(button => button && !button.hidden)
      .map(button => h("button", { type: "button", className: "btn btn--sm list-filter-action",
        textContent: button.textContent, onclick: () => button.click() }));
    return h("details", { className: "list-filter", open: listFilter.open,
      ontoggle: event => {
        // A rebuilt list re-creates the menu already open, which also fires toggle; only a real opening moves focus.
        const opened = event.target.open && !listFilter.open;
        listFilter.open = event.target.open;
        if (opened) event.target.querySelector(".list-filter-search")?.focus();
      } },
    h("summary", { className: "btn btn--icon", title: "Filter the list and map by name, distance or number of papers",
      attrs: { "aria-label": "Filters" } }, filterIcon()),
    h("div", { className: "list-filter-panel menu-panel", attrs: { role: "group", "aria-label": "Filters" } },
      h("div", { className: "list-filter-search-wrap" }, search, clear),
      h("label", { className: "list-filter-field" }, h("span", { textContent: "Distance" }), distance),
      h("label", { className: "list-filter-field" }, h("span", { textContent: "Min papers per link" }), papers),
      ...excludedActions));
  }

  function renderResults(focus) {
    const causes = state.task === "causes";
    const { status, rows } = neighborhood();
    // A notice appears only when there is something to say; otherwise the list stands on its own.
    const notice = text => { els.summary.textContent = text; els.summary.hidden = !text; };
    if (status === "loading") {
      // Only after a local edit: links it touched are counted from their findings.
      loadPaperSupport();
      notice("Counting the papers behind your edits…");
      replaceChildren(els.results);
      return;
    }
    notice(!rows.length ? `Nothing ${causes ? "causes" : "is caused by"} ${labelFor(focus)} at this distance and paper count. Try a greater distance or fewer papers.`
      : status === "failed" ? "Some paper details could not load, so links changed by your edits may be missing." : "");
    // Two sections, custom variables then built-in ones; within each, nearer first.
    // Rows further than one step say which variables they go through.
    const isCustom = id => groupFor(id)?.source === "user_split";
    const ordered = rows.map((row, index) => ({ row, index }))
      .sort((a, b) => a.row.distance - b.row.distance || a.index - b.index).map(({ row }) => row);
    const sections = [
      { key: "custom", title: "Custom variables", items: ordered.filter(row => isCustom(row.groupId)),
        empty: "None of your custom variables are linked here." },
      { key: "builtin", title: "Built-in variables", items: ordered.filter(row => !isCustom(row.groupId)), empty: "None." },
    ];
    // Rows hover their link on the graph; leaving the list clears it.
    const hover = item => onRowHover(item ? { edgeId: item.edgeId, groupId: item.groupId, pathEdgeIds: item.pathEdgeIds } : null);
    replaceChildren(els.results, sections.map(({ key, title, items, empty }, sectionIndex) => {
      const includedCount = items.filter(item => !item.excluded).length;
      const all = h("input", { type: "checkbox", className: "explore-include",
        checked: items.length > 0 && includedCount === items.length, disabled: !items.length, dataset: { section: key },
        title: includedCount === items.length ? "Exclude all of these from the map" : "Include all of these in the map",
        attrs: { "aria-label": `Include all ${title.toLowerCase()} in the map` },
        onchange: event => setIncluded(items.map(item => item.groupId), event.target.checked,
          `.explore-include[data-section="${key}"]`) });
      all.indeterminate = includedCount > 0 && includedCount < items.length;
      return h("section", { className: "explore-group", dataset: { section: key } },
        h("div", { className: "explore-group-header" },
          all,
          h("h2", { textContent: title }),
          // One filter, beside the first heading, narrows both sections; Create sits with it.
          sectionIndex === 0 ? h("span", { className: "explore-group-tools" }, createVariableButton(onCreateCustom), listFilterControl())
            : h("span"),
          h("span", { className: "explore-papers-header", textContent: "Papers",
            title: "Distinct papers supporting the link; for a variable further away, its weakest link" })),
        h("ol", { className: "explore-list" }, items.map(item => {
          const distance = item.distance;
          const between = item.path.slice(1, -1).map(labelFor);
          const toward = causes ? item.path[1] : item.path[item.path.length - 2];
          const count = distance === 1 ? item.papers : item.weakestPapers;
          const group = groupFor(item.groupId);
          return h("li", { className: `explore-row${item.excluded ? " is-excluded" : ""}${key === "custom" ? " has-actions" : ""}`,
            dataset: { groupId: item.groupId, distance: String(distance), edgeId: item.edgeId } },
          h("input", { type: "checkbox", className: "explore-include", checked: !item.excluded,
            dataset: { groupId: item.groupId },
            title: item.excluded ? "Show on the map" : "Leave off the map",
            attrs: { "aria-label": `Include ${labelFor(item.groupId)} in the map` },
            onchange: event => setIncluded([item.groupId], event.target.checked,
              `.explore-include[data-group-id="${CSS.escape(item.groupId)}"]`) }),
          h("button", { type: "button", className: "explore-row-open",
            attrs: { "aria-pressed": String(state.selectedEdgeId === item.edgeId),
              "aria-label": `${labelFor(item.groupId)}, ${plural(count, "paper")}${distance === 1 ? "" : " on the weakest link"}` },
            title: `See the evidence that ${causes ? `${labelFor(item.groupId)} causes ${labelFor(toward)}`
              : `${labelFor(toward)} causes ${labelFor(item.groupId)}`}`,
            onclick: () => openEvidence(item.edgeId),
            onmouseenter: () => hover(item.excluded ? null : item), onmouseleave: () => hover(null),
            onfocus: () => hover(item.excluded ? null : item), onblur: () => hover(null) },
          h("span", { className: "explore-row-text" },
            h("span", { className: "explore-row-label", textContent: labelFor(item.groupId) }),
            between.length ? h("span", { className: "explore-row-path", textContent: `via ${between.join(" → ")}` }) : null),
          h("span", { className: "explore-row-papers", textContent: String(count) })),
          key === "custom" && group ? customVariableActions({ group, canChange: canChangeCustom,
            onEdit: onEditCustom, onDelete: onDeleteCustom }) : null);
        })),
        h("p", { className: "explore-subsection-empty list-filter-empty", dataset: { empty },
          hidden: items.length > 0, textContent: empty }));
    }));
    applyListSearch();
  }

  /** Mark the row for a variable hovered on the graph (null clears it). */
  function highlightRow(groupId) {
    for (const row of els.results.querySelectorAll(".explore-row.is-hovered")) row.classList.remove("is-hovered");
    if (!groupId || !state.task) return;
    els.results.querySelector(`.explore-row[data-group-id="${CSS.escape(groupId)}"]`)?.classList.add("is-hovered");
  }

  /** Cheaply mark the row whose evidence is open, without rebuilding the list. */
  function refreshSelection() {
    if (identifying()) {
      for (const button of els.results.querySelectorAll(".explore-row-open")) {
        button.setAttribute("aria-pressed", String(button.closest(".explore-row").dataset.groupId === state.selectedEvidenceGroupId));
      }
      return;
    }
    if (!exploring()) return;
    for (const button of els.results.querySelectorAll(".explore-row-open")) {
      const selected = button.closest(".explore-row").dataset.edgeId === state.selectedEdgeId;
      button.setAttribute("aria-pressed", String(selected));
    }
  }

  // ── Identification: Cause, Outcome and Instrument fields over the same list as Explore ──
  const identifying = () => state.task === "identify";
  const identifyInput = side => el(`identify-${side}-input`);
  const anchorId = side => {
    const id = state.project?.[`${side}_group_id`];
    return id && groupFor(id) ? id : null;
  };
  /** The field whose list is open: the one being searched, else the first study variable still missing. */
  function identifySide() {
    if (!identifying() || state.definitionDraft) return null;
    if (identifyPicking) return identifyPicking;
    if (!anchorConfigured("iv")) return "iv";
    if (!anchorConfigured("dv")) return "dv";
    return null;
  }
  const identifyReady = () => anchorConfigured("iv") && anchorConfigured("dv");

  /** Variables unticked in Identify, kept only while the same cause and outcome are chosen. */
  const identifyExclusionKey = () => `${state.project?.iv_group_id || ""}\u0000${state.project?.dv_group_id || ""}`;
  function identifyExcluded() {
    const stored = state.identifyExclusion;
    return new Set(stored?.key === identifyExclusionKey() ? stored.ids : []);
  }
  function setIdentifyIncluded(groupIds, include, focusSelector = null) {
    const excluded = identifyExcluded();
    for (const id of groupIds) {
      if (include) excluded.delete(id);
      else excluded.add(id);
    }
    state.identifyExclusion = excluded.size ? { key: identifyExclusionKey(), ids: [...excluded] } : null;
    onIdentifyExcludedChange();
    onChange();
    if (focusSelector) els.results.querySelector(focusSelector)?.focus();
  }

  function startIdentifyPicking(side) {
    if (identifyPicking === side) return;
    identifyPicking = side;
    const input = identifyInput(side);
    // Start from the full list, not a search for the current variable's name.
    if (input && anchorId(side)) input.value = "";
    onIdentifyPicking();
  }
  function cancelIdentifyPicking() {
    if (!identifyPicking) return;
    const side = identifyPicking;
    identifyPicking = null;
    const id = anchorId(side);
    const input = identifyInput(side);
    if (input) input.value = id ? labelFor(id) : "";
    onIdentifyPicking();
  }
  function chooseIdentify(side, groupId) {
    identifyPicking = null;
    identifyInput(side)?.blur();
    onChooseIdentify(side, groupId);
  }

  function renderIdentifyFields() {
    const picking = identifySide();
    for (const side of IDENTIFY_SIDES) {
      const input = identifyInput(side);
      if (!input) continue;
      const id = anchorId(side);
      const label = id ? labelFor(id) : "";
      const active = picking === side;
      if (!active && document.activeElement !== input) input.value = label;
      input.placeholder = active && id ? `Search to replace ${label}` : side === "instrument" ? "Optional" : "Search group or constituent variable";
      input.closest(".identify-field")?.classList.toggle("has-focus", Boolean(id));
      input.closest(".identify-field")?.classList.toggle("is-picking", active);
      const clear = input.parentElement.querySelector(".identify-clear");
      if (clear) clear.hidden = !(input.value || (side === "instrument" && id));
    }
  }

  /**
   * Every variable on offer, narrowed by the panel's own filter to the confounders or
   * colliders when one is chosen. A candidate's routes and weakest link come from that
   * filter, or with no filter from the diagnostic the map shows.
   */
  function identifyRows() {
    const view = pathView({ ...state, exploring: false });
    const spec = IDENTIFY_VIEWS[identifyKind] || IDENTIFY_VIEWS[view];
    const anchors = new Set(IDENTIFY_SIDES.map(anchorId).filter(Boolean));
    const candidates = IDENTIFY_VIEWS[identifyKind] ? new Set(state[IDENTIFY_VIEWS[identifyKind].ids] || []) : null;
    const ids = groups().map(group => group.group_id)
      .filter(id => !anchors.has(id) && (!candidates || candidates.has(id)));
    const support = paperSupport();
    const counter = support.papersFor ? cachedCounter(support) : null;
    const pairs = new Map((state.visibleLinks || []).map(link => [[link.group_a, link.group_b].sort().join("\u0000"), link]));
    const hopPapers = (from, to) => {
      const link = pairs.get([from, to].sort().join("\u0000"));
      return link && counter ? counter(link, link.group_a === from) : null;
    };
    const excluded = identifyExcluded();
    const rows = ids.filter(id => isDisplayGroup(groupFor(id))).map(id => {
      const routes = witnessRoutes(spec && state[spec.paths]?.get(id));
      // Which variables a route goes through is only listed once the filter narrows to candidates.
      const between = candidates
        ? [...new Set(routes.flatMap(route => route.slice(1, -1)).filter(step => step !== id && !anchors.has(step)))] : [];
      const counts = routes.flatMap(route => route.slice(1).map((step, index) => hopPapers(route[index], step)))
        .filter(count => Number.isFinite(count));
      return { groupId: id, between, papers: counts.length ? Math.min(...counts) : null, excluded: excluded.has(id) };
    });
    // A variable left off the map drops out of the diagnostics, so the filtered list keeps it by hand.
    const listed = new Set(rows.map(row => row.groupId));
    for (const id of excluded) {
      if (!listed.has(id) && !anchors.has(id) && groupFor(id)) rows.push({ groupId: id, between: [], papers: null, excluded: true });
    }
    rows.sort((a, b) => labelFor(a.groupId).localeCompare(labelFor(b.groupId)));
    return { view, noun: IDENTIFY_VIEWS[identifyKind]?.noun || "variables", rows };
  }

  /** The panel's filter: every variable, or only the confounders or colliders. */
  function identifyKindControl() {
    return h("div", { className: "identify-kind segmented", attrs: { role: "group", "aria-label": "Show variables" } },
      IDENTIFY_KINDS.map(([kind, label, title]) => h("button", { type: "button", className: "btn btn--sm", textContent: label, title,
        attrs: { "aria-pressed": String(identifyKind === kind) },
        onclick: () => {
          if (identifyKind === kind) return;
          identifyKind = kind;
          renderIdentifyResults();
          els.results.querySelector(`.identify-kind [aria-pressed="true"]`)?.focus();
        } })));
  }

  function renderIdentifyResults() {
    const { view, noun, rows } = identifyRows();
    const notice = text => { els.summary.textContent = text; els.summary.hidden = !text; };
    notice(rows.length || identifyKind === "all" ? ""
      : `No ${noun} at this path length and paper count. Try a longer path or fewer papers in the filters.`);
    // Rebuild only when the rows change, so a filter being typed into keeps its focus.
    const key = JSON.stringify([view, identifyKind, rows, state.selectedEvidenceGroupId, listFilter.query]);
    const filter = document.querySelector(".dag-ws-controls > .filter-dropdown, #exploreResults .filter-dropdown");
    if (key === identifyListKey && els.results.contains(filter)) return;
    identifyListKey = key;
    const refocus = filter?.contains(document.activeElement) ? document.activeElement : null;
    const isCustom = id => groupFor(id)?.source === "user_split";
    const sections = [
      { key: "custom", title: "Custom variables", items: rows.filter(row => isCustom(row.groupId)),
        empty: `None of your custom variables are ${noun} here.` },
      { key: "builtin", title: "Built-in variables", items: rows.filter(row => !isCustom(row.groupId)), empty: "None." },
    ];
    replaceChildren(els.results, identifyKindControl(), ...sections.map(({ key, title, items, empty }, sectionIndex) => {
      const includedCount = items.filter(item => !item.excluded).length;
      const all = h("input", { type: "checkbox", className: "explore-include",
        checked: items.length > 0 && includedCount === items.length, disabled: !items.length, dataset: { section: key },
        title: includedCount === items.length ? "Exclude all of these from the map" : "Include all of these in the map",
        attrs: { "aria-label": `Include all ${title.toLowerCase()} in the map` },
        onchange: event => setIdentifyIncluded(items.map(item => item.groupId), event.target.checked,
          `.explore-include[data-section="${key}"]`) });
      all.indeterminate = includedCount > 0 && includedCount < items.length;
      return h("section", { className: "explore-group", dataset: { section: key } },
        h("div", { className: "explore-group-header" },
          all,
          h("h2", { textContent: title }),
          // Create and the map's filters sit beside the first heading, as Explore's do.
          sectionIndex === 0 ? h("span", { className: "explore-group-tools identify-tools" }, createVariableButton(onCreateCustom))
            : h("span"),
          h("span", { className: "explore-papers-header", textContent: "Papers",
            title: "Distinct papers supporting the weakest link on the paths shown for this variable" })),
        h("ol", { className: "explore-list" }, items.map(item => {
          const group = groupFor(item.groupId);
          const label = labelFor(item.groupId);
          return h("li", { className: `explore-row${item.excluded ? " is-excluded" : ""}${key === "custom" ? " has-actions" : ""}`,
            dataset: { groupId: item.groupId } },
          h("input", { type: "checkbox", className: "explore-include", checked: !item.excluded,
            dataset: { groupId: item.groupId },
            title: item.excluded ? "Show on the map" : "Leave off the map",
            attrs: { "aria-label": `Include ${label} in the map` },
            onchange: event => setIdentifyIncluded([item.groupId], event.target.checked,
              `.explore-include[data-group-id="${CSS.escape(item.groupId)}"]`) }),
          h("button", { type: "button", className: "explore-row-open",
            attrs: { "aria-pressed": String(state.selectedEvidenceGroupId === item.groupId),
              "aria-label": item.papers === null ? label : `${label}, ${plural(item.papers, "paper")} on the weakest link` },
            title: `See the definition and concepts of ${label}`,
            onclick: () => onOpenIdentifyVariable(item.groupId),
            onmouseenter: () => onIdentifyRowHover(item.excluded ? null : item.groupId), onmouseleave: () => onIdentifyRowHover(null),
            onfocus: () => onIdentifyRowHover(item.excluded ? null : item.groupId), onblur: () => onIdentifyRowHover(null) },
          h("span", { className: "explore-row-text" },
            h("span", { className: "explore-row-label", textContent: label }),
            item.between.length ? h("span", { className: "explore-row-path", textContent: `via ${item.between.map(labelFor).join(", ")}` }) : null),
          h("span", { className: "explore-row-papers", textContent: item.papers === null ? "" : String(item.papers) })),
          key === "custom" && group ? customVariableActions({ group, canChange: canChangeCustom,
            onEdit: onEditCustom, onDelete: onDeleteCustom }) : null);
        })),
        h("p", { className: "explore-subsection-empty list-filter-empty", dataset: { empty },
          hidden: items.length > 0, textContent: empty }));
    }));
    if (filter) els.results.querySelector(".identify-tools")?.append(filter);
    refocus?.focus();
    applyListSearch();
  }

  function renderIdentify() {
    renderIdentifyFields();
    if (els.definition) els.definition.hidden = true;
    const picking = identifySide();
    const ready = identifyReady();
    els.resultsBlock.hidden = !ready || Boolean(picking);
    if (!els.resultsBlock.hidden) renderIdentifyResults();
    else identifyListKey = null;
    els.graphHint.hidden = ready;
    els.graphHint.textContent = anchorConfigured("iv")
      ? "Choose an outcome to see what could bias the effect of the cause on it."
      : "Choose a cause and an outcome to see what could bias the effect of one on the other.";
  }

  function renderExplore() {
    const causes = state.task === "causes";
    syncFocusClear();
    // While searching for another variable, the matches take the list's place.
    const { groupId, picking } = focus();
    els.resultsBlock.hidden = !groupId || picking;
    if (groupId && !picking) renderResults(groupId);
    els.graphHint.hidden = Boolean(groupId);
    els.graphHint.textContent = `Choose a variable to see its ${causes ? "causes" : "consequences"} as a graph.`;
    // The direction toggle and selected-variable control already say what the graph shows.
    if (els.graphTitle) els.graphTitle.textContent = "";
    // The filters keep their usual controls; here "Max path" is how many causal steps to follow.
    els.pathLabel.textContent = "Distance";
    els.pathInput.max = String(MAX_NEIGHBORHOOD_DEPTH);
    els.pathInput.setAttribute("aria-label", "Distance in causal steps");
    els.pathInput.title = `How many causal steps from the variable to follow (1 to ${MAX_NEIGHBORHOOD_DEPTH}).`;
    els.pathInput.value = String(state.confounderMaxPathLength);
  }

  // No task has a strip above the map: its view switches sit in the top bar
  // (Causes | Consequences in Explore, the diagnostics in Identify, then Graph | Table),
  // and Identify's filters sit beside the list's first heading.
  function placeViewControls() {
    const slot = el("taskBarViewControls");
    const header = el("dagWorkspaceSection")?.querySelector(".dag-ws-controls");
    const viewSwitch = document.querySelector(".dag-view-switch");
    const diagnostic = document.querySelector(".dag-diagnostic-switch");
    const filter = document.querySelector(".filter-dropdown");
    if (!slot || !header || !viewSwitch || !diagnostic) return;
    const wanted = !state.task ? [] : exploring() ? [els.direction, viewSwitch] : [diagnostic, viewSwitch];
    if (wanted.some((node, index) => slot.children[index] !== node) || slot.children.length !== wanted.length) {
      // Whatever leaves the top bar goes back to the graph header, where Identify's markup keeps it.
      for (const node of [els.direction, diagnostic, viewSwitch]) {
        if (!wanted.includes(node) && node.parentElement === slot) header.append(node);
      }
      slot.append(...wanted);
    }
    if (filter && !identifying() && filter.parentElement !== header) {
      filter.open = false;
      header.append(filter);
    }
  }

  function render() {
    const task = state.task;
    placeEvidencePane();
    // In every task the evidence replaces the map, so its close button goes back to it.
    const closeEvidence = el("closeEvidencePane");
    if (closeEvidence) {
      // Lucide "map" icon, inline like the other toolbar icons.
      if (task) closeEvidence.replaceChildren(mapIcon(), backToMapLabel());
      else closeEvidence.textContent = "Close";
      closeEvidence.setAttribute("aria-label", task ? "Back to the map" : "Close evidence or description");
    }
    for (const [name, className] of Object.entries(TASK_CLASSES)) document.body.classList.toggle(className, task === name);
    document.body.classList.toggle("task-home", !task);
    els.bar.hidden = false;
    if (exploring()) lastDirection = task;
    for (const tab of els.bar.querySelectorAll("button[data-task]")) {
      const pressed = tab.dataset.task === "explore" ? exploring() : tab.dataset.task === task;
      tab.setAttribute("aria-pressed", String(pressed));
    }
    const taskValue = el("taskMenuValue");
    if (taskValue) taskValue.textContent = exploring() ? "Exploration" : "Identification";
    for (const button of els.direction.querySelectorAll("button[data-direction]")) {
      const pressed = button.dataset.direction === task;
      button.setAttribute("aria-pressed", String(pressed));
      button.classList.toggle("active", pressed);
    }
    placeViewControls();
    els.reset.hidden = !task;
    // The start page covers the app until a task is chosen.
    if (els.landing) els.landing.hidden = Boolean(task);
    els.explore.hidden = !task;
    const browserIntro = el("identifyBrowserIntro");
    if (browserIntro) browserIntro.hidden = !identifying();
    const identifyFields = el("identifyFields");
    if (identifyFields) identifyFields.hidden = !identifying();
    if (!identifying()) identifyPicking = null;
    els.graphHint.hidden = true;
    if (!exploring()) {
      els.pathLabel.textContent = "Max path";
      els.pathInput.max = "99";
      els.pathInput.setAttribute("aria-label", "Maximum confounder path length");
    } else if (settingsTask !== state.task) adoptViewSettings();
    // On a phone the same panel tabs switch between the list and the graph.
    for (const tab of document.querySelectorAll(".mobile-panel-nav [data-mobile-panel]")) {
      const panel = tab.dataset.mobilePanel;
      tab.dataset.identifyLabel ||= tab.textContent;
      tab.textContent = task && EXPLORE_NAV_LABELS[panel] ? EXPLORE_NAV_LABELS[panel] : tab.dataset.identifyLabel;
    }
    if (exploring()) {
      // Start loading paper support while the user is still choosing a variable.
      if (paperSupport().status === "loading") loadPaperSupport();
      renderExplore();
    } else if (identifying()) {
      if (paperSupport().status === "loading") loadPaperSupport();
      renderIdentify();
    }
  }

  function install() {
    el("taskHome")?.addEventListener("click", showLanding);
    for (const button of document.querySelectorAll("#taskLanding button[data-task]")) {
      button.addEventListener("click", () => setTask(button.dataset.task));
    }
    for (const button of document.querySelectorAll("#taskBar button[data-task]")) {
      button.addEventListener("click", () => {
        const menu = button.closest("details");
        if (menu) menu.open = false;
        setTask(button.dataset.task);
      });
    }
    for (const button of els.direction.querySelectorAll("button[data-direction]")) {
      button.addEventListener("click", () => setDirection(button.dataset.direction));
    }
    els.focusInput.addEventListener("input", () => { syncFocusClear(); onPickerInput(); });
    els.focusClear?.addEventListener("click", () => clearFocus());
    // With a variable chosen, the search box is a combobox: focusing it opens
    // the list of groups; Escape, Tab or a click elsewhere closes it unchanged.
    const searchBlock = els.focusInput.closest(".search-block");
    els.focusInput.addEventListener("focus", () => {
      if (exploring() && focusId() && !changing[state.task]) changeFocus();
    });
    els.focusInput.addEventListener("keydown", event => {
      if (event.key === "Escape" && exploring() && changing[state.task] && focusId()) {
        event.preventDefault();
        cancelChange();
        els.focusInput.blur();
      }
    });
    searchBlock?.addEventListener("focusout", event => {
      if (exploring() && event.relatedTarget && !searchBlock.contains(event.relatedTarget) && focusId()) cancelChange();
    });
    document.addEventListener("pointerdown", event => {
      if (exploring() && focusId() && searchBlock && !searchBlock.contains(event.target)) cancelChange();
    });
    els.pickerCancel.addEventListener("click", () => cancelChange());
    // Identify's fields: focusing one opens the variable list under them; Escape,
    // Tab or a click elsewhere closes it and shows the chosen variable again.
    const identifyFields = el("identifyFields");
    for (const side of IDENTIFY_SIDES) {
      const input = identifyInput(side);
      if (!input) continue;
      input.addEventListener("focus", () => { if (identifying()) startIdentifyPicking(side); });
      input.addEventListener("input", () => { renderIdentifyFields(); onIdentifyPicking(); });
      input.addEventListener("keydown", event => {
        if (event.key !== "Escape" || !identifyPicking) return;
        event.preventDefault();
        cancelIdentifyPicking();
        input.blur();
      });
      input.parentElement.querySelector(".identify-clear")?.addEventListener("click", () => {
        // With a variable chosen, × removes it from that role; with only a search typed, it clears the search.
        input.value = "";
        if (anchorId(side)) { chooseIdentify(side, null); return; }
        renderIdentifyFields();
        onIdentifyPicking();
        input.focus();
      });
    }
    identifyFields?.addEventListener("focusout", event => {
      if (identifying() && event.relatedTarget && !identifyFields.contains(event.relatedTarget)) cancelIdentifyPicking();
    });
    document.addEventListener("pointerdown", event => {
      if (identifying() && identifyPicking && identifyFields && !identifyFields.contains(event.target)) cancelIdentifyPicking();
    });
    els.reset.addEventListener("click", () => {
      const menu = els.reset.closest("details");
      if (menu) menu.open = false;
      els.dialog.showModal();
    });
    el("resetContinue").addEventListener("click", () => els.dialog.close());
    el("resetNewTab").addEventListener("click", () => {
      openWindow(freshProjectUrl(window.location.href));
      els.dialog.close();
    });
    el("resetHere").addEventListener("click", async () => {
      const message = el("resetError");
      try {
        // Pressed during start-up, Reset waits for the saving layer rather than failing: the project must reach Sessions first.
        message.hidden = true;
        await whenReady();
        prepareReset();
        navigate(freshProjectUrl(window.location.href));
      } catch (error) {
        message.textContent = `Could not keep this project in Sessions — ${error.message}`;
        message.hidden = false;
      }
    });
  }

  return { install, render, setTask, setDirection, refreshSelection, highlightRow, neighborhood, exploring, focus, searchFocusGroups,
    chooseFocus, changeFocus, freshProjectUrl, identifySide, identifyExcluded, chooseIdentify,
    cancelIdentify: cancelIdentifyPicking };
}
