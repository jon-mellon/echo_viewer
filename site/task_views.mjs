import { h, replaceChildren } from "./dom_builder.mjs";
import { causalNeighborhood, MAX_NEIGHBORHOOD_DEPTH } from "./causal_neighborhood.mjs";

const TASK_CLASSES = { identify: "task-identify", causes: "task-causes", consequences: "task-consequences" };
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const EXPLORE_NAV_LABELS = { controls: "Variables view", dag: "Map view" };
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

/** A fresh project on the same published schema and evidence, opening at the start page. */
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

// The start page, the task bar, the causes and consequences views, and Reset.
// Causes and consequences share the Identify workspace: the list and controls
// replace the left panel, and the graph and the evidence for a clicked link use
// the same network and evidence pane Identify uses.
export function createTaskViews({ state, searchGroups, searchStatus = () => "ready", onChange = () => {},
  paperSupport = () => ({ status: "ready", papersFor: undefined }), loadPaperSupport = () => {},
  isDisplayGroup = () => true, onExploreChange = () => {}, onTaskChange = () => {},
  onFocusPicking = () => {}, onPickerInput = () => {}, onSetupNeeded = () => {}, openEvidence = () => {},
  onRowHover = () => {}, placeEvidencePane = () => {}, prepareReset = () => {}, whenReady = () => Promise.resolve(), openWindow = (url) => window.open(url, "_blank", "noopener"),
  navigate = (url) => window.location.assign(url) }) {
  const el = id => document.getElementById(id);
  const els = {
    bar: el("taskBar"), reset: el("taskReset"), direction: el("exploreDirection"), landing: el("taskLanding"), explore: el("exploreView"),
    resultsBlock: el("exploreResultsBlock"), summary: el("exploreSummary"),
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
  // Causes and consequences are one Explore view with a direction toggle; the
  // Explore tab reopens whichever direction was last shown.
  let lastDirection = "causes";
  // The list's own filter: whether its menu is open and the name being searched.
  // The search narrows the list only; the paper minimum is the view's setting, so it shapes the graph too.
  const listFilter = { open: false, query: "" };

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
    else adoptViewSettings();
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
    let shown = 0;
    for (const group of els.results.querySelectorAll(".explore-group")) {
      let groupShown = 0;
      for (const row of group.querySelectorAll(".explore-row")) {
        const match = !query || row.querySelector(".explore-row-label").textContent.toLowerCase().includes(query);
        row.hidden = !match;
        if (match) groupShown += 1;
      }
      group.hidden = !groupShown && !group.querySelector(".list-filter");
      shown += groupShown;
    }
    const empty = els.results.querySelector(".list-filter-empty");
    if (empty) empty.hidden = !query || shown > 0;
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
    const byDistance = new Map();
    for (const row of rows) {
      if (!byDistance.has(row.distance)) byDistance.set(row.distance, []);
      byDistance.get(row.distance).push(row);
    }
    // Rows hover their link on the graph; leaving the list clears it.
    const hover = item => onRowHover(item ? { edgeId: item.edgeId, groupId: item.groupId } : null);
    // With nothing listed the heading and its filter still show, so the paper minimum can be lowered here.
    if (!byDistance.size) byDistance.set(1, []);
    const firstDistance = Math.min(...byDistance.keys());
    replaceChildren(els.results, [...byDistance].map(([distance, items]) => {
      const title = distance === 1 ? (causes ? "Direct causes" : "Direct consequences") : `${distance} steps away`;
      const includedCount = items.filter(item => !item.excluded).length;
      const all = h("input", { type: "checkbox", className: "explore-include",
        checked: includedCount === items.length, dataset: { distance: String(distance) },
        title: includedCount === items.length ? "Exclude all of these from the map" : "Include all of these in the map",
        attrs: { "aria-label": `Include all ${title.toLowerCase()} in the map` },
        onchange: event => setIncluded(items.map(item => item.groupId), event.target.checked,
          `.explore-include[data-distance="${distance}"]`) });
      all.indeterminate = includedCount > 0 && includedCount < items.length;
      return h("section", { className: "explore-group" },
        h("div", { className: "explore-group-header" },
          all,
          h("h2", { textContent: title }),
          distance === firstDistance ? listFilterControl() : h("span"),
          h("span", { className: "explore-papers-header", textContent: "Papers",
            title: distance === 1 ? "Distinct papers supporting the link"
              : "Distinct papers supporting the weakest link on the path" })),
        h("ol", { className: "explore-list" }, items.map(item => {
          const between = item.path.slice(1, -1).map(labelFor);
          const toward = causes ? item.path[1] : item.path[item.path.length - 2];
          const count = distance === 1 ? item.papers : item.weakestPapers;
          return h("li", { className: `explore-row${item.excluded ? " is-excluded" : ""}`,
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
          h("span", { className: "explore-row-papers", textContent: String(count) })));
        })));
    }), h("p", { className: "menu-note list-filter-empty", hidden: true, textContent: "No listed variable matches this search." }));
    applyListSearch();
  }

  /** Mark the row for a variable hovered on the graph (null clears it). */
  function highlightRow(groupId) {
    for (const row of els.results.querySelectorAll(".explore-row.is-hovered")) row.classList.remove("is-hovered");
    if (!groupId || !exploring()) return;
    els.results.querySelector(`.explore-row[data-group-id="${CSS.escape(groupId)}"]`)?.classList.add("is-hovered");
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

  function render() {
    const task = state.task;
    placeEvidencePane();
    // In Explore the evidence replaces the map, so its close button goes back to it.
    const closeEvidence = el("closeEvidencePane");
    if (closeEvidence) {
      // Lucide "map" icon, inline like the other toolbar icons.
      if (exploring()) closeEvidence.replaceChildren(mapIcon(), backToMapLabel());
      else closeEvidence.textContent = "Close";
      closeEvidence.setAttribute("aria-label", exploring() ? "Back to the map" : "Close evidence or description");
    }
    for (const [name, className] of Object.entries(TASK_CLASSES)) document.body.classList.toggle(className, task === name);
    document.body.classList.toggle("task-home", !task);
    els.bar.hidden = false;
    if (exploring()) lastDirection = task;
    for (const tab of els.bar.querySelectorAll("button[data-task]")) {
      const pressed = tab.dataset.task === "explore" ? exploring() : tab.dataset.task === task;
      tab.setAttribute("aria-pressed", String(pressed));
    }
    const taskToggle = el("taskMenuToggle");
    if (taskToggle) taskToggle.textContent = exploring() ? "Exploration" : "Identification";
    for (const button of els.direction.querySelectorAll("button[data-direction]")) {
      const pressed = button.dataset.direction === task;
      button.setAttribute("aria-pressed", String(pressed));
      button.classList.toggle("active", pressed);
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
      button.addEventListener("click", () => {
        const menu = button.closest("details");
        if (menu) menu.open = false;
        setTask(button.dataset.task);
      });
    }
    for (const button of els.direction.querySelectorAll("button[data-direction]")) {
      button.addEventListener("click", () => setDirection(button.dataset.direction));
    }
    els.focusInput.addEventListener("input", () => onPickerInput());
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
    chooseFocus, changeFocus, freshProjectUrl };
}
