import { directedGroupLabels } from "./dag_exports.mjs";

// A table of exactly what the graph draws. Each row is a path: the variables
// along it are buttons that open their definitions, and the arrows between
// them are buttons that open the evidence for that link, so the table carries
// the graph's interactions as ordinary controls. It serves keyboard and
// screen-reader use, and graphs too dense to read.

export const TABLE_PAGE_SIZE = 200;

function paperPrefixes(keys) {
  return Array.isArray(keys) ? keys.map(key => String(key).split("::")[0]) : null;
}

/** Distinct papers behind the direction(s) a link points; null when the DAG carries no paper keys. */
export function linkPapers(link) {
  const forward = paperPrefixes(link.a_to_b_paper_table_keys);
  const backward = paperPrefixes(link.b_to_a_paper_table_keys);
  if (!forward && !backward) return null;
  const shown = link.direction_type === "A_TO_B" ? forward
    : link.direction_type === "B_TO_A" ? backward : [...(forward || []), ...(backward || [])];
  return new Set(shown || []).size;
}

const pairKey = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** Most paths listed per candidate and side, so a densely connected variable cannot flood the table. */
export const MAX_PATHS_PER_SIDE = 25;

function outgoingMap(links) {
  const outgoing = new Map();
  const add = (from, to) => { if (!outgoing.has(from)) outgoing.set(from, new Set()); outgoing.get(from).add(to); };
  for (const link of links) {
    if (link.direction_type !== "B_TO_A") add(link.group_a, link.group_b);
    if (link.direction_type === "B_TO_A" || link.direction_type === "BIDIRECTIONAL") add(link.group_b, link.group_a);
  }
  return outgoing;
}

/**
 * Every directed path of at most `maxLength` links from one variable to another
 * through the drawn links, never through a blocked variable, shortest first.
 */
export function enumeratePaths(outgoing, fromId, toId, { blocked = [], maxLength = 1, cap = MAX_PATHS_PER_SIDE } = {}) {
  const found = [];
  const walk = path => {
    const last = path[path.length - 1];
    if (last === toId) { found.push(path); return; }
    if (path.length > maxLength) return;
    for (const next of outgoing.get(last) || []) {
      if (path.includes(next) || blocked.includes(next)) continue;
      walk([...path, next]);
    }
  };
  walk([fromId]);
  return found.sort((a, b) => a.length - b.length).slice(0, cap);
}

/** The route labels each view shows, and where its paths come from. */
const PATH_VIEWS = {
  confounders: { fields: ["toIv", "toDv"], headers: ["Path to Ind var", "Path to Dep var"], candidate: "Confounder" },
  exogeneity: { fields: ["toIv", "toDv"], headers: ["Path to Instrument", "Path to Dep var"], candidate: "Common cause" },
  colliders: { fields: ["fromIv", "fromDv"], headers: ["Path from Ind var", "Path from Dep var"], candidate: "Collider" },
  exclusion: { fields: ["toDv"], headers: ["Path to Dep var"], candidate: "Variable" },
};

/** Which diagnostic the graph is showing, in the order the graph gives them precedence. */
export function pathView({ showExogeneity, showExclusionViolations, showCollidersOnly, showConfoundersOnly, exploring }) {
  if (exploring) return "explore";
  if (showExogeneity) return "exogeneity";
  if (showExclusionViolations) return "exclusion";
  if (showCollidersOnly) return "colliders";
  if (showConfoundersOnly) return "confounders";
  return "links";
}

/**
 * Rows for the tables. A path is `{ nodes: [{ id, label }], edgeIds }` with one
 * link per hop (null where none is drawn). A row is a candidate (a confounder,
 * say) with paths paired internally by side. The table renders each path on
 * its own row, with the candidate cell spanning those rows. Views without
 * candidates have one path per row. `pathsByGroup`
 * holds the diagnostic's own witness paths by candidate, `exploreRows` the
 * neighborhood's, already in causal order.
 */
export function dagTableModel({ view, groups, links, pathsByGroup = new Map(), exploreRows = [],
  anchors = {}, maxPathLength = 1, roleFor = () => "", studyLinks = [] }) {
  const byId = new Map(groups.map(group => [group.group_id, group]));
  const label = id => byId.get(id)?.label || id;
  const edgeByPair = new Map(links.map(link => [pairKey(link.group_a, link.group_b), link.edge_id]));
  const linkById = new Map(links.map(link => [link.edge_id, link]));
  const chain = (ids, edgeIds) => ({
    nodes: ids.map(id => ({ id, label: label(id) })),
    edgeIds: edgeIds || ids.slice(1).map((id, index) => edgeByPair.get(pairKey(ids[index], id)) || null),
  });
  const none = { nodes: [], edgeIds: [] };
  const hasPaperColumn = view === "explore" || view === "links";
  let headers, rows, candidateHeader = null;
  if (view === "explore") {
    headers = ["Path"];
    rows = exploreRows.map(row => ({ id: row.groupId, lines: [[chain(row.path, row.pathEdgeIds)]], papers: row.weakestPapers }));
  } else if (view === "links") {
    headers = ["Link"];
    rows = links.map(link => {
      const reversed = link.direction_type === "B_TO_A";
      const ids = reversed ? [link.group_b, link.group_a] : [link.group_a, link.group_b];
      return { id: link.edge_id, lines: [[chain(ids, [link.edge_id])]], papers: linkPapers(link) };
    });
  } else {
    ({ headers, candidate: candidateHeader } = PATH_VIEWS[view]);
    const outgoing = outgoingMap(links);
    const { ivId, dvId, instrumentId } = anchors;
    const first = view === "exogeneity" ? instrumentId : ivId;
    rows = [];
    for (const [groupId, stored] of pathsByGroup) {
      if (!byId.has(groupId)) continue;
      // Every path the graph could draw for this candidate, its own witness path first.
      const sides = view === "exclusion" ? [stored?.length > 1 ? [stored] : []]
        : [{ target: first, blocked: dvId }, { target: dvId, blocked: first }].map(({ target, blocked }, side) => {
          const own = stored?.[PATH_VIEWS[view].fields[side]];
          const found = enumeratePaths(outgoing, view === "colliders" ? target : groupId, view === "colliders" ? groupId : target,
            { blocked: [blocked], maxLength: maxPathLength });
          const key = path => path.join("\u0000");
          const listed = own?.length > 1 ? [own] : [];
          return [...listed, ...found.filter(path => !listed.some(item => key(item) === key(path)))];
        });
      const count = Math.max(...sides.map(list => list.length));
      if (!count) continue;
      const lines = Array.from({ length: count }, (_, index) => sides.map(list => list[index] ? chain(list[index]) : none));
      rows.push({ id: groupId, label: label(groupId), lines, papers: null });
    }
    rows.sort((a, b) => a.label.localeCompare(b.label));
  }
  const linkCounts = new Map();
  for (const link of links) for (const id of [link.group_a, link.group_b]) linkCounts.set(id, (linkCounts.get(id) || 0) + 1);
  const study = studyLinks.filter(item => byId.has(item.sourceId) && byId.has(item.targetId))
    .map(item => ({ id: item.edgeId, note: item.note, chains: [chain([item.sourceId, item.targetId], [item.edgeId])] }));
  // Links the view draws that no listed path uses (for instance with "Path links only" off).
  const inPaths = new Set(rows.flatMap(row => row.lines.flat().flatMap(path => path.edgeIds)));
  const otherLinks = view === "links" ? [] : links.filter(link => !inPaths.has(link.edge_id)).map(link => {
    const ids = link.direction_type === "B_TO_A" ? [link.group_b, link.group_a] : [link.group_a, link.group_b];
    return { id: link.edge_id, chains: [chain(ids, [link.edge_id])], papers: linkPapers(link) };
  });
  return {
    headers, rows, study, otherLinks, hasPaperColumn, linkById, candidateHeader,
    pathCount: rows.reduce((total, row) => total + (candidateHeader
      ? row.lines.flat().filter(path => path.nodes.length).length : row.lines.length), 0),
    variableRows: groups.map(group => ({ groupId: group.group_id, label: group.label, role: roleFor(group),
      variables: group.variable_ids?.length || group.member_count || 0, links: linkCounts.get(group.group_id) || 0 })),
  };
}

const VARIABLE_SORTS = {
  label: (a, b) => a.label.localeCompare(b.label),
  links: (a, b) => b.links - a.links || a.label.localeCompare(b.label),
  variables: (a, b) => b.variables - a.variables || a.label.localeCompare(b.label),
};

export function sortedPathRows(rows, sortByPapers) {
  return sortByPapers ? rows.slice().sort((a, b) => (b.papers ?? -1) - (a.papers ?? -1)) : rows.slice();
}

export function createDagTable({ container, onOpenVariable, onOpenEvidence }) {
  const doc = container.ownerDocument;
  let model = { headers: [], rows: [], study: [], otherLinks: [], variableRows: [], hasPaperColumn: false, linkById: new Map() };
  let selection = { edgeId: null, groupId: null };
  let shownSignature = null;
  let sortByPapers = false, variableSort = "links";
  let shownRows = TABLE_PAGE_SIZE, shownOther = TABLE_PAGE_SIZE, shownVariables = TABLE_PAGE_SIZE;

  function el(tag, props = {}, ...children) {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value === true ? "" : value);
    }
    node.append(...children.filter(Boolean));
    return node;
  }
  const button = (text, label, onClick, props = {}) => {
    const node = el("button", { type: "button", class: "text-button dag-table-action", "aria-label": label, text, ...props });
    node.addEventListener("click", onClick);
    return node;
  };

  /** One path: variable, arrow, variable ...; each arrow opens that link's evidence. */
  function pathCell(path, routeLabel = null) {
    const cell = el("td", { class: "dag-table-path" });
    if (routeLabel) cell.append(el("span", { class: "dag-table-route-label", text: routeLabel }));
    path.nodes.forEach((node, index) => {
      if (index > 0) {
        const edgeId = path.edgeIds[index - 1];
        const from = path.nodes[index - 1].label, to = node.label;
        if (edgeId) {
          const link = model.linkById.get(edgeId);
          const both = link?.direction_type === "BIDIRECTIONAL";
          const selected = edgeId === selection.edgeId;
          cell.append(button(both ? "⟷" : "⟶", `Show the evidence for ${from} to ${to}`, () => onOpenEvidence(edgeId),
            { class: `text-button dag-table-action dag-table-arrow${selected ? " selected" : ""}`, "data-edge-id": edgeId,
              "aria-pressed": selected ? "true" : "false" }));
        } else cell.append(el("span", { class: "dag-table-arrow", "aria-hidden": "true", text: "⟶" }));
      }
      cell.append(button(node.label, `Open the definition of ${node.label}`, () => onOpenVariable(node.id),
        { class: "text-button dag-table-action dag-table-node", "data-group-id": node.id }));
    });
    return cell;
  }

  const headerCell = (text, sortable, active, onSort) => !sortable ? el("th", { scope: "col", text })
    : el("th", { scope: "col", "aria-sort": active ? "descending" : "none" },
      button(text, `${text}: sort the table by this column`, onSort));

  function more(shown, total, noun, expand) {
    if (shown >= total) return null;
    return el("p", { class: "dag-table-more" }, button(`Show ${Math.min(TABLE_PAGE_SIZE, total - shown)} more ${noun}`,
      `Show more ${noun}; ${total - shown} not yet shown`, expand), el("span", { text: ` Showing ${shown} of ${total}.` }));
  }

  function studyTable() {
    if (!model.study.length) return [];
    return [el("table", { class: "dag-table", id: "dagStudyTable" },
      el("caption", { text: "Study design" }),
      el("tbody", {}, ...model.study.map(row => el("tr", {}, pathCell(row.chains[0]), el("td", { text: row.note })))))];
  }

  function pathsTable() {
    const rows = sortedPathRows(model.rows, sortByPapers && model.hasPaperColumn);
    const columns = model.candidateHeader
      ? [headerCell(model.candidateHeader), headerCell("Route")]
      : [...model.headers.map(text => headerCell(text)),
        ...(model.hasPaperColumn ? [headerCell("Papers", true, sortByPapers, () => { sortByPapers = !sortByPapers; render(); })] : [])];
    const body = el("tbody", {});
    for (const row of rows.slice(0, shownRows)) {
      const routes = model.candidateHeader
        ? model.headers.flatMap((header, side) => row.lines.map(line => line[side])
          .filter(path => path.nodes.length).map(path => ({ header, path })))
        : row.lines.map(line => ({ line }));
      routes.forEach((route, index) => {
        const tr = el("tr", { "data-row-id": row.id, class: index === 0 ? "dag-table-first-line" : "" });
        // One cell for the candidate spans every route listed below it.
        if (model.candidateHeader && index === 0) {
          const cell = el("th", { scope: "row", rowspan: routes.length, class: "dag-table-candidate" },
            button(row.label, `Open the definition of ${row.label}`, () => onOpenVariable(row.id),
              { class: "text-button dag-table-action dag-table-node", "data-group-id": row.id }));
          tr.append(cell);
        }
        if (model.candidateHeader) {
          tr.append(pathCell(route.path, route.header.replace(/^Path (to|from) /, (_, direction) => `${direction === "to" ? "To" : "From"} `)));
        } else tr.append(...route.line.map(path => path.nodes.length ? pathCell(path) : el("td", { text: "–" })));
        if (model.hasPaperColumn) tr.append(el("td", { class: "dag-table-number", text: row.papers === null || row.papers === undefined ? "–" : String(row.papers) }));
        body.append(tr);
      });
    }
    const table = el("table", { class: "dag-table", id: "dagPathsTable" },
      el("caption", { text: `Paths in this view (${model.pathCount})` }),
      el("thead", {}, el("tr", {}, ...columns)), body);
    return [table, more(shownRows, rows.length, model.candidateHeader ? "variables" : "paths", () => { shownRows += TABLE_PAGE_SIZE; render(); })];
  }

  function otherLinksTable() {
    if (!model.otherLinks.length) return [];
    const table = el("table", { class: "dag-table", id: "dagOtherLinksTable" },
      el("caption", { text: `Other links in this view (${model.otherLinks.length})` }),
      el("thead", {}, el("tr", {}, headerCell("Link"), headerCell("Papers"))),
      el("tbody", {}, ...model.otherLinks.slice(0, shownOther).map(row => el("tr", { "data-row-id": row.id },
        pathCell(row.chains[0]),
        el("td", { class: "dag-table-number", text: row.papers === null ? "–" : String(row.papers) })))));
    return [table, more(shownOther, model.otherLinks.length, "links", () => { shownOther += TABLE_PAGE_SIZE; render(); })];
  }

  function variablesTable() {
    const rows = model.variableRows.slice().sort(VARIABLE_SORTS[variableSort]);
    const sorter = (text, key) => headerCell(text, true, variableSort === key, () => { variableSort = key; render(); });
    const table = el("table", { class: "dag-table", id: "dagVariablesTable" },
      el("caption", { text: `Variables in this view (${rows.length})` }),
      el("thead", {}, el("tr", {}, sorter("Variable", "label"), headerCell("Role"), sorter("Variables", "variables"), sorter("Links", "links"))),
      el("tbody", {}, ...rows.slice(0, shownVariables).map(row => {
        const selected = row.groupId === selection.groupId;
        return el("tr", { "data-group-id": row.groupId, class: selected ? "selected" : "", "aria-current": selected ? "true" : null },
          el("td", {}, button(row.label, `Open the definition of ${row.label}`, () => onOpenVariable(row.groupId),
            { "aria-pressed": selected ? "true" : "false" })),
          el("td", { text: row.role }),
          el("td", { class: "dag-table-number", text: String(row.variables) }),
          el("td", { class: "dag-table-number", text: String(row.links) }));
      })));
    return [table, more(shownVariables, rows.length, "variables", () => { shownVariables += TABLE_PAGE_SIZE; render(); })];
  }

  function render() {
    const focused = doc.activeElement && container.contains(doc.activeElement)
      ? doc.activeElement.getAttribute("aria-label") : null;
    const scroll = container.scrollTop;
    container.replaceChildren(
      el("p", { class: "dag-table-summary", role: "status", text: model.variableRows.length
        ? `${model.variableRows.length} variables, ${model.pathCount} paths and ${model.otherLinks.length} other links, the same as the graph. Arrows open the evidence for a link.`
        : "Nothing to show yet." }),
      // Tables return null for a "Show more" line they do not need; replaceChildren would print it as the text "null".
      ...[...studyTable(), ...pathsTable(), ...otherLinksTable(), ...variablesTable()].filter(Boolean));
    container.scrollTop = scroll;
    // Re-sorting or selecting rebuilds the table; keep the keyboard user where they were.
    if (focused) [...container.querySelectorAll("button")].find(node => node.getAttribute("aria-label") === focused)?.focus();
  }

  return {
    update(next) {
      // A render with nothing new (a late data load, a repeated filter) keeps the table, and the reader's place in it.
      const signature = JSON.stringify([next.headers, next.candidateHeader, next.rows, next.study, next.otherLinks, next.variableRows,
        [...next.linkById].map(([id, link]) => [id, link.direction_type])]);
      if (signature === shownSignature) { model = next; return; }
      shownSignature = signature;
      model = next;
      shownRows = shownOther = shownVariables = TABLE_PAGE_SIZE;
      render();
    },
    select(next) {
      const changed = next.edgeId !== selection.edgeId || next.groupId !== selection.groupId;
      selection = { edgeId: next.edgeId || null, groupId: next.groupId || null };
      if (!changed) return;
      for (const arrow of container.querySelectorAll(".dag-table-arrow[data-edge-id]")) {
        const selected = arrow.dataset.edgeId === selection.edgeId;
        arrow.classList.toggle("selected", selected);
        arrow.setAttribute("aria-pressed", selected ? "true" : "false");
      }
      for (const row of container.querySelectorAll("tr[data-group-id]")) {
        const selected = row.dataset.groupId === selection.groupId;
        row.classList.toggle("selected", selected);
        if (selected) row.setAttribute("aria-current", "true"); else row.removeAttribute("aria-current");
        row.querySelector(".dag-table-action[aria-pressed]")?.setAttribute("aria-pressed", selected ? "true" : "false");
      }
    },
    model: () => model,
  };
}
