import { h, replaceChildren } from "./dom_builder.mjs";
import { causalNeighborhood, MAX_NEIGHBORHOOD_DEPTH } from "./causal_neighborhood.mjs";

const TASK_CLASSES = { identify: "task-identify", causes: "task-causes", consequences: "task-consequences" };
const MIN_PAPER_CHOICES = [1, 2, 3, 5, 10];
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A fresh project on the same published schema and evidence, opening at the start page. */
export function freshProjectUrl(href) {
  const current = new URL(href);
  const fresh = new URL(current.pathname, current.origin);
  for (const key of ["schema", "data_version", "evidence_manifest"]) {
    if (current.searchParams.has(key)) fresh.searchParams.set(key, current.searchParams.get(key));
  }
  return fresh.href;
}

// The start page, the task bar, the causes and consequences views, and Reset.
// Identification keeps using the existing workspace underneath; these views
// only cover it, so switching tasks never discards its state.
export function createTaskViews({ state, searchGroups, searchStatus = () => "ready", onChange = () => {},
  paperSupport = () => ({ status: "ready", papersFor: undefined }), loadPaperSupport = () => {},
  flushUrl = async () => {}, openWindow = (url) => window.open(url, "_blank", "noopener"),
  navigate = (url) => window.location.assign(url) }) {
  const el = id => document.getElementById(id);
  const els = {
    bar: el("taskBar"), reset: el("taskReset"), landing: el("taskLanding"), explore: el("exploreView"),
    title: el("exploreTitle"), chosen: el("exploreChosen"), focusLabel: el("exploreFocusLabel"),
    change: el("exploreChange"), picker: el("explorePicker"), search: el("exploreSearch"),
    pickerList: el("explorePickerList"), pickerCancel: el("explorePickerCancel"),
    depth: el("exploreDepth"), minPapers: el("exploreMinPapers"), summary: el("exploreSummary"),
    results: el("exploreResults"), dialog: el("resetDialog"),
  };
  // Whether the user asked to change the focus; not part of the saved view.
  const changing = { causes: false, consequences: false };
  // Paper counts per link direction, reused until the links or support change.
  let countCache = { key: null, counts: new Map() };

  const exploring = () => state.task === "causes" || state.task === "consequences";
  const view = () => state.explore[state.task];
  const groups = () => state.project?.groups || [];
  const groupFor = id => groups().find(group => group.group_id === id);
  const labelFor = id => groupFor(id)?.label || id;
  const focusId = () => (groupFor(view().focusId) ? view().focusId : null);

  function setTask(task) {
    if (state.task === task) return;
    state.task = task;
    render();
    onChange();
  }

  function updateView(patch) {
    Object.assign(view(), patch);
    renderExplore();
    onChange();
  }

  function chooseFocus(groupId) {
    changing[state.task] = false;
    els.search.value = "";
    updateView({ focusId: groupId });
  }

  function renderPicker() {
    const query = els.search.value.trim();
    const hydrated = groups().some(group => group.variable_ids?.length);
    const available = groups().filter(group => !hydrated || group.variable_ids?.length);
    const matches = query ? searchGroups(available, query, 200)
      : [...available].sort((a, b) => labelFor(a.group_id).localeCompare(labelFor(b.group_id)))
        .map(group => ({ group, variableMatch: "" }));
    const status = searchStatus();
    const note = query && status !== "ready" ? h("p", { className: "small-note", textContent: status === "error"
      ? "Variable search could not be loaded; only variable names are searched."
      : "Loading variable search… variable names match for now." }) : null;
    replaceChildren(els.pickerList, note, matches.length ? matches.map(({ group, variableMatch }) =>
      h("button", { type: "button", className: "explore-pick", dataset: { groupId: group.group_id },
        onclick: () => chooseFocus(group.group_id) },
      h("strong", { textContent: labelFor(group.group_id) }),
      group.variable_ids?.length ? h("span", { textContent: plural(group.variable_ids.length, "constituent variable") }) : null,
      variableMatch ? h("span", { className: "setup-group-variable-match", textContent: `Matched: ${variableMatch}` }) : null))
      : h("p", { className: "small-note", textContent: "No variables match this search." }));
  }

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

  function renderResults(focus) {
    const causes = state.task === "causes";
    const { depth, minPapers } = view();
    const support = paperSupport();
    if (support.status === "loading") {
      // The same per-finding records the sparse-edge filter uses; loaded once.
      loadPaperSupport();
      els.summary.textContent = "Counting the papers that support each link…";
      replaceChildren(els.results);
      return;
    }
    const rows = causalNeighborhood({ links: state.project?.links || [], focusId: focus,
      direction: state.task, depth, minPapers, papersFor: support.papersFor && cachedCounter(support) });
    const focusLabel = labelFor(focus);
    const within = `within ${plural(depth, "step")}, counting links supported by at least ${plural(minPapers, "paper")}`;
    const caveat = support.status === "failed"
      ? " Finding details could not load, so paper counts may include tables and null findings." : "";
    els.summary.textContent = (rows.length
      ? `${plural(rows.length, "variable")} ${causes ? (rows.length === 1 ? "causes" : "cause") : (rows.length === 1 ? "is caused by" : "are caused by")} ${focusLabel} ${within}.`
      : `No variables ${causes ? "cause" : "are caused by"} ${focusLabel} ${within}. Try a greater distance or fewer papers per link.`) + caveat;
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
          return h("li", { className: "explore-row", dataset: { groupId: item.groupId, distance: String(distance) } },
            h("button", { type: "button", className: "explore-row-label", textContent: labelFor(item.groupId),
              title: `Show ${causes ? "causes" : "consequences"} of ${labelFor(item.groupId)}`,
              onclick: () => chooseFocus(item.groupId) }),
            h("span", { className: "explore-row-papers", textContent: distance === 1
              ? plural(item.papers, "paper") : `weakest link: ${plural(item.weakestPapers, "paper")}` }),
            between.length ? h("span", { className: "explore-row-path", textContent: `via ${between.join(" → ")}` }) : null);
        })))));
  }

  function renderExplore() {
    const causes = state.task === "causes";
    els.title.textContent = causes ? "Causes of a variable" : "Consequences of a variable";
    const focus = focusId();
    const picking = !focus || changing[state.task];
    els.chosen.hidden = picking;
    els.picker.hidden = !picking;
    els.pickerCancel.hidden = !focus;
    els.focusLabel.textContent = focus ? labelFor(focus) : "";
    els.search.placeholder = `Search for the variable whose ${causes ? "causes" : "consequences"} you want`;
    for (const button of els.depth.querySelectorAll("button[data-depth]")) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.depth) === view().depth));
    }
    els.minPapers.value = String(view().minPapers);
    if (picking) renderPicker();
    if (focus) renderResults(focus);
    else {
      els.summary.textContent = `Choose a variable to see its ${causes ? "causes" : "consequences"}.`;
      replaceChildren(els.results);
    }
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
    replaceChildren(els.depth, h("span", { className: "explore-control-label", textContent: "Distance" }),
      Array.from({ length: MAX_NEIGHBORHOOD_DEPTH }, (_, index) => h("button", {
        type: "button", className: "toolbar-button", dataset: { depth: String(index + 1) },
        textContent: String(index + 1), attrs: { "aria-pressed": "false", "aria-label": `Distance ${index + 1}` },
        onclick: () => updateView({ depth: index + 1 }) })));
    replaceChildren(els.minPapers, MIN_PAPER_CHOICES.map(value =>
      h("option", { value: String(value), textContent: String(value) })));
    els.minPapers.addEventListener("change", () => updateView({ minPapers: Number(els.minPapers.value) }));
    els.search.addEventListener("input", renderPicker);
    els.change.addEventListener("click", () => {
      changing[state.task] = true;
      renderExplore();
      els.search.focus();
    });
    els.pickerCancel.addEventListener("click", () => {
      changing[state.task] = false;
      els.search.value = "";
      renderExplore();
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

  return { install, render, setTask, freshProjectUrl };
}
