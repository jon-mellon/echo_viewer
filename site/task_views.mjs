import { h, replaceChildren } from "./dom_builder.mjs";
import { causalNeighborhood, MAX_NEIGHBORHOOD_DEPTH } from "./causal_neighborhood.mjs";

const TASK_CLASSES = { identify: "task-identify", causes: "task-causes", consequences: "task-consequences" };
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const EXPLORE_NAV_LABELS = { controls: "List", dag: "Graph" };
const IDENTIFY_DEFAULTS = { confounderMaxPathLength: 1, excludeSparseEdges: false, minimumEdgePapers: 2 };
const clampDepth = value => Math.max(1, Math.min(MAX_NEIGHBORHOOD_DEPTH, Math.trunc(Number(value)) || 1));

/** A fresh project on the same published schema and evidence, opening at the start page. */
export function freshProjectUrl(href) {
  const current = new URL(href);
  const fresh = new URL(current.pathname, current.origin);
  for (const key of ["schema", "data_version", "evidence_manifest"]) {
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

// The start page, the task bar, the causes and consequences views, and Reset.
// Causes and consequences share the Identify workspace: the list and controls
// replace the left panel, and the graph and the evidence for a clicked link use
// the same network and evidence pane Identify uses.
export function createTaskViews({ state, searchGroups, searchStatus = () => "ready", onChange = () => {},
  paperSupport = () => ({ status: "ready", papersFor: undefined }), loadPaperSupport = () => {},
  isDisplayGroup = () => true, onExploreChange = () => {}, onTaskChange = () => {},
  onFocusPicking = () => {}, onPickerInput = () => {}, openEvidence = () => {}, flushUrl = async () => {}, openWindow = (url) => window.open(url, "_blank", "noopener"),
  navigate = (url) => window.location.assign(url) }) {
  const el = id => document.getElementById(id);
  const els = {
    bar: el("taskBar"), reset: el("taskReset"), landing: el("taskLanding"), explore: el("exploreView"),
    resultsBlock: el("exploreResultsBlock"), summary: el("exploreSummary"), hint: el("exploreHint"),
    results: el("exploreResults"), dialog: el("resetDialog"), graphHint: el("exploreGraphHint"),
    graphTitle: el("dagViewTitle"), focusInput: el("focusInput"), pickerCancel: el("focusPickerCancel"),
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

  const exploring = () => state.task === "causes" || state.task === "consequences";
  const view = () => state.explore[state.task];
  const groups = () => state.project?.groups || [];
  const groupFor = id => groups().find(group => group.group_id === id);
  const labelFor = id => groupFor(id)?.label || id;
  const focusId = () => (groupFor(view().focusId) ? view().focusId : null);

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
   * Count the papers behind every link ahead of the first pick, a slice at a
   * time so the page stays responsive. The counts are cached for neighborhood().
   */
  let warming = false;
  async function warmCounts() {
    const support = paperSupport();
    if (warming || support.status !== "ready" || !support.papersFor) return;
    warming = true;
    try {
      const links = state.project?.links || [];
      const counter = cachedCounter(support);
      let sliceStart = performance.now();
      for (let index = 0; index < links.length; index++) {
        counter(links[index], true);
        counter(links[index], false);
        if ((index & 63) === 63 && performance.now() - sliceStart > 8) {
          await new Promise(resolve => setTimeout(resolve, 0));
          sliceStart = performance.now();
          if (state.project?.links !== links) return;
        }
      }
    } finally {
      warming = false;
    }
  }

  /**
   * The list rows and graph for the current view, shared by the list and the
   * graph and reused until the links, support or settings change.
   */
  function neighborhood() {
    const focus = exploring() ? focusId() : null;
    if (!focus) return { status: "none", rows: [], graph: { groupIds: new Set(), links: [], layout: null } };
    const support = paperSupport();
    if (support.status === "loading") return { status: "loading", rows: [], graph: { groupIds: new Set(), links: [], layout: null } };
    const { depth, minPapers } = settings();
    const links = state.project?.links || [];
    const key = [state.task, focus, depth, minPapers, links, links.length, groups(), support.status, support.cacheKey,
      support.cacheKey?.size];
    if (hoodCache.key && key.every((part, index) => part === hoodCache.key[index])) return hoodCache.value;
    const hidden = new Set(groups().filter(group => !isDisplayGroup(group)).map(group => group.group_id));
    const rows = causalNeighborhood({ links, focusId: focus, direction: state.task, depth, minPapers,
      papersFor: support.papersFor && cachedCounter(support), isNode: id => !hidden.has(id) });
    const value = { status: support.status, rows, graph: neighborhoodGraph({ rows, focusId: focus, links, direction: state.task }) };
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
    else adoptViewSettings();
  }

  function setTask(task) {
    if (state.task === task) return;
    const previous = state.task;
    swapTask(previous, task);
    changing.causes = false;
    changing.consequences = false;
    onTaskChange({ previous, task });
    render();
    onChange();
  }

  function chooseFocus(groupId) {
    changing[state.task] = false;
    els.focusInput.value = "";
    if (groupId !== view().focusId) {
      view().focusId = groupId;
      // The open evidence belongs to the old neighborhood.
      state.selectedEdgeId = null;
    }
    onExploreChange();
    onChange();
  }

  function changeFocus() {
    changing[state.task] = true;
    onFocusPicking();
    els.focusInput.focus();
  }

  function renderResults(focus) {
    const causes = state.task === "causes";
    const { depth, minPapers } = settings();
    const { status, rows } = neighborhood();
    if (status === "loading") {
      // The same per-finding records the sparse-edge filter uses; loaded once.
      loadPaperSupport();
      els.summary.textContent = "Counting the papers that support each link…";
      els.hint.hidden = true;
      replaceChildren(els.results);
      return;
    }
    const focusLabel = labelFor(focus);
    const within = `within ${plural(depth, "step")}, counting links supported by at least ${plural(minPapers, "paper")}`;
    const caveat = status === "failed"
      ? " Finding details could not load, so paper counts may include tables and null findings." : "";
    els.summary.textContent = (rows.length
      ? `${plural(rows.length, "variable")} ${causes ? (rows.length === 1 ? "causes" : "cause") : (rows.length === 1 ? "is caused by" : "are caused by")} ${focusLabel} ${within}.`
      : `No variables ${causes ? "cause" : "are caused by"} ${focusLabel} ${within}. Try a greater distance or fewer papers per link.`) + caveat;
    els.hint.hidden = !rows.length;
    const byDistance = new Map();
    for (const row of rows) {
      if (!byDistance.has(row.distance)) byDistance.set(row.distance, []);
      byDistance.get(row.distance).push(row);
    }
    replaceChildren(els.results, [...byDistance].map(([distance, items]) =>
      h("section", { className: "explore-group" },
        h("h2", { textContent: distance === 1 ? (causes ? "Direct causes" : "Direct consequences")
          : `${distance} steps away` }),
        h("ol", { className: "explore-list" }, items.map(item => {
          const between = item.path.slice(1, -1).map(labelFor);
          const toward = causes ? item.path[1] : item.path[item.path.length - 2];
          return h("li", { className: "explore-row", dataset: { groupId: item.groupId, distance: String(distance),
            edgeId: item.edgeId } },
          h("button", { type: "button", className: "explore-row-open",
            attrs: { "aria-pressed": String(state.selectedEdgeId === item.edgeId) },
            title: `See the evidence that ${causes ? `${labelFor(item.groupId)} causes ${labelFor(toward)}`
              : `${labelFor(toward)} causes ${labelFor(item.groupId)}`}`,
            onclick: () => openEvidence(item.edgeId) },
          h("span", { className: "explore-row-label", textContent: labelFor(item.groupId) }),
          h("span", { className: "explore-row-papers", textContent: distance === 1
            ? plural(item.papers, "paper") : `weakest link: ${plural(item.weakestPapers, "paper")}` }),
          between.length ? h("span", { className: "explore-row-path", textContent: `via ${between.join(" → ")}` }) : null),
          h("button", { type: "button", className: "text-button explore-row-refocus",
            textContent: `Explore ${causes ? "its causes" : "its consequences"}`,
            attrs: { "aria-label": `Explore ${causes ? "causes" : "consequences"} of ${labelFor(item.groupId)}` },
            onclick: () => chooseFocus(item.groupId) }));
        })))));
  }

  /** Cheaply mark the row whose evidence is open, without rebuilding the list. */
  function refreshSelection() {
    if (!exploring()) return;
    for (const button of els.results.querySelectorAll(".explore-row-open")) {
      const selected = button.closest(".explore-row").dataset.edgeId === state.selectedEdgeId;
      button.setAttribute("aria-pressed", String(selected));
    }
  }

  function renderExplore() {
    const causes = state.task === "causes";
    const { groupId, picking } = focus();
    els.resultsBlock.hidden = !groupId || picking;
    if (groupId && !picking) renderResults(groupId);
    els.hint.textContent = "Select a variable to see the evidence behind its link, or select a link in the graph.";
    els.graphHint.hidden = Boolean(groupId);
    els.graphHint.textContent = `Choose a variable to see its ${causes ? "causes" : "consequences"} as a graph.`;
    if (els.graphTitle) {
      els.graphTitle.textContent = groupId ? `${causes ? "Causes of" : "Consequences of"} ${labelFor(groupId)}` : "Working map";
    }
    // The filters keep their usual controls; here "Max path" is how many causal steps to follow.
    els.pathLabel.textContent = "Distance";
    els.pathInput.max = String(MAX_NEIGHBORHOOD_DEPTH);
    els.pathInput.setAttribute("aria-label", "Distance in causal steps");
    els.pathInput.title = `How many causal steps from the variable to follow (1 to ${MAX_NEIGHBORHOOD_DEPTH}).`;
    els.pathInput.value = String(state.confounderMaxPathLength);
  }

  function render() {
    const task = state.task;
    for (const [name, className] of Object.entries(TASK_CLASSES)) document.body.classList.toggle(className, task === name);
    document.body.classList.toggle("task-home", !task);
    els.bar.hidden = false;
    for (const tab of els.bar.querySelectorAll("button[data-task]")) {
      tab.setAttribute("aria-pressed", String(tab.dataset.task === task));
    }
    els.reset.hidden = !task;
    els.landing.hidden = Boolean(task);
    els.explore.hidden = !exploring();
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
      tab.textContent = exploring() && EXPLORE_NAV_LABELS[panel] ? EXPLORE_NAV_LABELS[panel] : tab.dataset.identifyLabel;
    }
    if (exploring()) {
      // Start loading paper support while the user is still choosing a variable.
      if (paperSupport().status === "loading") loadPaperSupport();
      renderExplore();
    }
  }

  function install() {
    for (const button of document.querySelectorAll("#taskBar button[data-task], #taskLanding button[data-task]")) {
      button.addEventListener("click", () => setTask(button.dataset.task));
    }
    els.focusInput.addEventListener("input", () => onPickerInput());
    els.pickerCancel.addEventListener("click", () => {
      changing[state.task] = false;
      els.focusInput.value = "";
      onFocusPicking();
    });
    els.reset.addEventListener("click", () => els.dialog.showModal());
    el("resetContinue").addEventListener("click", () => els.dialog.close());
    el("resetNewTab").addEventListener("click", () => {
      openWindow(freshProjectUrl(window.location.href));
      els.dialog.close();
    });
    el("resetHere").addEventListener("click", async () => {
      // Record the current project in Previous Sessions before leaving it.
      try { await flushUrl(); } catch { /* Resetting must not depend on saving history. */ }
      navigate(freshProjectUrl(window.location.href));
    });
  }

  return { install, render, setTask, refreshSelection, neighborhood, warmCounts, exploring, focus, searchFocusGroups,
    chooseFocus, changeFocus, freshProjectUrl };
}
