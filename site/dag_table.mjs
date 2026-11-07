import { directedGroupLabels } from "./dag_exports.mjs";
import { CONTROL_WARNING } from "./confounder_status.mjs";

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
  confounders: { fields: ["toIv", "toDv"], headers: ["Path to cause", "Path to outcome"], candidate: "Confounder" },
  exogeneity: { fields: ["toIv", "toDv"], headers: ["Path to Instrument", "Path to outcome"], candidate: "Common cause" },
  colliders: { fields: ["fromIv", "fromDv"], headers: ["Path from cause", "Path from outcome"], candidate: "Collider" },
  exclusion: { fields: ["toDv"], headers: ["Path to outcome"], candidate: "Variable" },
};

/** Identify's table for each diagnostic, in the side panel's Cause and Outcome words. */
const DIAGNOSTIC_TABLES = {
  confounders: { title: ({ iv, dv }) => `Confounders of ${iv} → ${dv}`, headers: ["Path to cause", "Path to outcome"] },
  colliders: { title: ({ iv, dv }) => `Colliders of ${iv} and ${dv}`, headers: ["Path from cause", "Path from outcome"] },
  exogeneity: { title: ({ instrument, dv }) => `Common causes of ${instrument} and ${dv}`, headers: ["Path to instrument", "Path to outcome"] },
  exclusion: { title: ({ instrument }) => `Exclusion restriction violations for ${instrument}`, headers: ["Path from instrument to outcome"] },
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
  exploreDirection = "causes", exploreFocusId = null,
  anchors = {}, maxPathLength = 1, roleFor = () => "", studyLinks = [], statuses = null }) {
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
    rows.sort((a, b) => String(a.label ?? "").localeCompare(String(b.label ?? "")));
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
  // Explore: one row per variable, nearest first. Each row has exactly one link, the step from the variable to its
  // neighbour toward the chosen variable (or from it, for consequences); every
  // neighbour on the way is closer, so it has its own row above.
  let explore = null;
  if (view === "explore") {
    const causes = exploreDirection !== "consequences";
    const item = row => {
      const target = causes ? row.path[1] : row.path[row.path.length - 2];
      const group = byId.get(row.groupId);
      return { id: row.groupId, label: label(row.groupId), edgeId: row.edgeId, targetId: target, targetLabel: label(target),
        papers: row.papers, concepts: group?.variable_ids?.length || Number(group?.member_count) || 0 };
    };
    explore = {
      causes, focusId: exploreFocusId, focusLabel: exploreFocusId ? label(exploreFocusId) : "",
      focusDescription: String(byId.get(exploreFocusId)?.description || "").trim(),
      sections: [{ title: causes ? "Causes" : "Consequences", rows: exploreRows.slice()
        .sort((a, b) => a.distance - b.distance).map(item) }],
    };
  }
  // Identify's diagnostics: the same shape as Explore's table, one row per candidate with
  // its paths to (or from) the study variables, in two sections, custom then built-in.
  let diagnostic = null;
  if (candidateHeader) {
    const { ivId, dvId, instrumentId } = anchors;
    const spec = DIAGNOSTIC_TABLES[view];
    const papersOf = paths => {
      const counts = paths.flatMap(path => path.edgeIds.map(id => (id ? linkPapers(linkById.get(id) || {}) : null)))
        .filter(count => Number.isFinite(count));
      return counts.length ? Math.min(...counts) : null;
    };
    const item = row => {
      const sides = PATH_VIEWS[view].fields.map((_, side) => row.lines.map(line => line[side]).filter(path => path?.nodes.length));
      const group = byId.get(row.id);
      return { id: row.id, label: row.label, sides, papers: papersOf(sides.flat()),
        concepts: group?.variable_ids?.length || Number(group?.member_count) || 0,
        ...(statuses ? { status: statuses.byId[row.id] || { status: "unaddressed", text: "" } } : {}) };
    };
    diagnostic = {
      title: spec.title({ iv: label(ivId), dv: label(dvId), instrument: label(instrumentId) }),
      headers: spec.headers,
      // Confounders and colliders: how the study handles each, set from a menu in its row.
      status: statuses ? { kind: statuses.kind, noun: statuses.noun, options: statuses.options } : null,
      sections: [
        // Where a variable came from is a schema question; review lists every candidate together.
        { title: statuses?.noun ? `${statuses.noun[0].toUpperCase()}${statuses.noun.slice(1)}s` : "Candidates", rows: [...rows.map(item), ...(statuses?.rejected || []).map(row => item({ id: row.groupId, label: row.label, lines: [], papers: null }))] },
      ],
    };
  }
  return {
    headers, rows, study, otherLinks, hasPaperColumn, linkById, candidateHeader, explore, diagnostic,
    pathCount: rows.reduce((total, row) => total + (candidateHeader
      ? row.lines.flat().filter(path => path.nodes.length).length : row.lines.length), 0),
    variableRows: groups.map(group => ({ groupId: group.group_id, label: group.label, role: roleFor(group),
      variables: group.variable_ids?.length || group.member_count || 0, links: linkCounts.get(group.group_id) || 0 })),
  };
}

const VARIABLE_SORTS = {
  label: (a, b) => String(a.label ?? "").localeCompare(String(b.label ?? "")),
  links: (a, b) => b.links - a.links || String(a.label ?? "").localeCompare(String(b.label ?? "")),
  variables: (a, b) => b.variables - a.variables || String(a.label ?? "").localeCompare(String(b.label ?? "")),
};

export function sortedPathRows(rows, sortByPapers) {
  return sortByPapers ? rows.slice().sort((a, b) => (b.papers ?? -1) - (a.papers ?? -1)) : rows.slice();
}

export function createDagTable({ container, onOpenVariable, onOpenEvidence, onSetStatus = () => {} }) {
  const doc = container.ownerDocument;
  let model = { headers: [], rows: [], study: [], otherLinks: [], variableRows: [], hasPaperColumn: false, linkById: new Map() };
  let selection = { edgeId: null, groupId: null };
  let shownSignature = null;
  let sortByPapers = false, variableSort = "links";
  // Explore's table: null keeps causal order (nearest first); otherwise "label", "papers" or "concepts".
  let exploreSort = null;
  // Identify's diagnostic table: null keeps name order; otherwise "papers" or "concepts".
  let diagnosticSort = null;
  // Rows whose other paths the reader opened, by candidate and side.
  const expandedRoutes = new Set();
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
    const node = el("button", { type: "button", class: "btn btn--ghost dag-table-action", "aria-label": label, text, ...props });
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
            { class: `btn btn--ghost dag-table-action dag-table-arrow${selected ? " selected" : ""}`, "data-edge-id": edgeId,
              "aria-pressed": selected ? "true" : "false" }));
        } else cell.append(el("span", { class: "dag-table-arrow", "aria-hidden": "true", text: "⟶" }));
      }
      cell.append(button(node.label, `Open the definition of ${node.label}`, () => onOpenVariable(node.id),
        { class: "btn btn--ghost dag-table-action dag-table-node", "data-group-id": node.id }));
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
      el("caption", { text: "Project design" }),
      el("tbody", {}, ...model.study.map(row => el("tr", {}, pathCell(row.chains[0]), el("td", { text: row.note })))))];
  }

  function pathsTable() {
    const rows = sortedPathRows(model.rows, sortByPapers && model.hasPaperColumn);
    const columns = model.candidateHeader
      ? [headerCell(model.candidateHeader), headerCell("Route")]
      : [...model.headers.map(text => headerCell(text)),
        ...(model.hasPaperColumn ? [headerCell("Papers", true, sortByPapers, () => { sortByPapers = !sortByPapers; render(); })] : [])];
    const body = el("tbody", {});
    const buildRows = row => {
      const trs = [];
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
              { class: "btn btn--ghost dag-table-action dag-table-node", "data-group-id": row.id }));
          tr.append(cell);
        }
        if (model.candidateHeader) {
          tr.append(pathCell(route.path, route.header.replace(/^Path (to|from) /, (_, direction) => `${direction === "to" ? "To" : "From"} `)));
        } else tr.append(...route.line.map(path => path.nodes.length ? pathCell(path) : el("td", { text: "–" })));
        if (model.hasPaperColumn) tr.append(el("td", { class: "dag-table-number", text: row.papers === null || row.papers === undefined ? "–" : String(row.papers) }));
        trs.push(tr);
      });
      return trs;
    };
    pendingFills.push({ body, items: rows.slice(0, shownRows), build: buildRows });
    const table = el("table", { class: "dag-table", id: "dagPathsTable", "data-path-count": model.pathCount },
      el("thead", {}, el("tr", {}, ...columns)), body);
    return [table, more(shownRows, rows.length, model.candidateHeader ? "variables" : "paths", () => { shownRows += TABLE_PAGE_SIZE; render(); })];
  }

  /** Explore: the chosen variable's name and definition, above its table. */
  function definitionBlock() {
    const { focusId, focusLabel, focusDescription } = model.explore;
    if (!focusId) return [];
    return [el("section", { class: "dag-table-definition", "aria-label": `Definition of ${focusLabel}` },
      el("h2", { text: focusLabel }),
      el("p", { class: focusDescription ? null : "is-empty",
        text: focusDescription || "No definition has been written for this variable." }))];
  }

  /** Explore: variable (opens its definition) and one link (opens that link's evidence). */
  function exploreTable() {
    const { causes, focusLabel, sections } = model.explore;
    const total = sections.reduce((sum, section) => sum + section.rows.length, 0);
    const caption = el("caption", {},
      el("strong", { text: `${causes ? "Causes" : "Consequences"} of ${focusLabel || "the chosen variable"}` }),
      el("span", { class: "dag-table-caption-note",
        text: " · Click a variable for its definition, a link for its evidence." }));
    const order = { label: (a, b) => String(a.label ?? "").localeCompare(String(b.label ?? "")),
      papers: (a, b) => (b.papers ?? -1) - (a.papers ?? -1) || String(a.label ?? "").localeCompare(String(b.label ?? "")),
      concepts: (a, b) => b.concepts - a.concepts || String(a.label ?? "").localeCompare(String(b.label ?? "")) }[exploreSort];
    // Sorting applies within each section; clicking the active column again restores causal order.
    const sortHeader = (text, key, numeric) => {
      const active = exploreSort === key;
      return el("th", { scope: "col", class: numeric ? "dag-table-number" : null,
        "aria-sort": active ? (key === "label" ? "ascending" : "descending") : "none" },
      button(`${text}${active ? (key === "label" ? " ↑" : " ↓") : ""}`,
        active ? `${text}: sorted; click to return to nearest first` : `Sort by ${text.toLowerCase()}`,
        () => { exploreSort = active ? null : key; render(); },
        { class: "btn btn--ghost dag-table-action dag-table-sort", "data-sort-key": key }));
    };
    const body = el("tbody", {});
    const items = sections.flatMap(section => [{ heading: section.title, count: section.rows.length },
      ...(order ? section.rows.slice().sort(order) : section.rows)]);
    pendingFills.push({ body, items: items.slice(0, shownRows + sections.length), build: entry => {
      if (entry.heading) {
        return [el("tr", { class: "dag-table-section" },
          el("th", { scope: "colgroup", colspan: 4, text: `${entry.heading} (${entry.count})` }))];
      }
      const link = model.linkById.get(entry.edgeId);
      const both = link?.direction_type === "BIDIRECTIONAL";
      const selected = entry.edgeId === selection.edgeId;
      const arrow = both ? "⟷" : causes ? "→" : "←";
      const papers = entry.papers === null || entry.papers === undefined ? "" : ` (${entry.papers})`;
      const pill = button(`${arrow} ${entry.targetLabel}`,
        causes ? `Show the evidence that ${entry.label} causes ${entry.targetLabel}${papers ? `, ${entry.papers} studies` : ""}`
          : `Show the evidence that ${entry.targetLabel} causes ${entry.label}${papers ? `, ${entry.papers} studies` : ""}`,
        () => onOpenEvidence(entry.edgeId),
        { class: `btn btn--ghost dag-table-action dag-table-link${selected ? " selected" : ""}`, "data-edge-id": entry.edgeId,
          "aria-pressed": selected ? "true" : "false" });
      return [el("tr", { "data-row-id": entry.id },
        el("th", { scope: "row", class: "dag-table-variable" },
          button(entry.label, `Open the definition of ${entry.label}`, () => onOpenVariable(entry.id),
            { class: "btn btn--ghost dag-table-action dag-table-node", "data-group-id": entry.id })),
        el("td", {}, pill),
        el("td", { class: "dag-table-number", text: papers ? String(entry.papers) : "–" }),
        el("td", { class: "dag-table-number", text: String(entry.concepts) }))];
    } });
    const table = el("table", { class: "dag-table dag-table-explore", id: "dagPathsTable", "data-path-count": total },
      caption,
      el("thead", {}, el("tr", {}, sortHeader("Variable", "label"), headerCell("Link"),
        sortHeader("Papers", "papers", true), sortHeader("Concepts", "concepts", true))),
      body);
    return [table, more(shownRows, total, "variables", () => { shownRows += TABLE_PAGE_SIZE; render(); })];
  }

  /** One link as a quiet text button: an arrow and the variable it reaches; opens that link's evidence. */
  function linkPill(edgeId, text, label) {
    const selected = edgeId === selection.edgeId;
    return button(text, label, () => onOpenEvidence(edgeId),
      { class: `btn btn--ghost dag-table-action dag-table-link${selected ? " selected" : ""}`, "data-edge-id": edgeId,
        "aria-pressed": selected ? "true" : "false" });
  }

  /**
   * A path read from the row's variable: "→ m → cause" when it starts there,
   * "← m ← cause" when it ends there, and the whole chain when it passes through
   * (an exclusion violation). Each step opens the evidence for that link.
   */
  function compactPath(path, candidateId) {
    const ids = path.nodes.map(node => node.id);
    const line = el("span", { class: "dag-table-route" });
    const hop = (index, reverse) => {
      const edgeId = path.edgeIds[index];
      const from = path.nodes[index].label, to = path.nodes[index + 1].label;
      const both = model.linkById.get(edgeId)?.direction_type === "BIDIRECTIONAL";
      const arrow = both ? "↔" : reverse ? "←" : "→";
      const target = reverse ? from : to;
      const text = `${arrow} ${target}`;
      return edgeId ? linkPill(edgeId, text, `Show the evidence that ${from} causes ${to}`)
        : el("span", { class: "dag-table-link", text });
    };
    if (ids[0] === candidateId) path.edgeIds.forEach((_, index) => line.append(hop(index, false)));
    else if (ids.at(-1) === candidateId) path.edgeIds.map((_, index) => index).reverse().forEach(index => line.append(hop(index, true)));
    else {
      line.append(el("span", { class: "dag-table-route-start", text: path.nodes[0].label }));
      path.edgeIds.forEach((_, index) => line.append(hop(index, false)));
    }
    return line;
  }

  /** Identify's study arrows (cause → outcome, instrument → cause) as one quiet line above the table. */
  function studyLine() {
    if (!model.study.length) return [];
    return [el("p", { class: "dag-table-study" }, el("span", { class: "dag-table-caption-note", text: "Project design: " }),
      ...model.study.map(row => {
        const [from, to] = row.chains[0].nodes;
        return linkPill(row.id, `${from.label} → ${to.label}`, `${row.note}: show the evidence that ${from.label} causes ${to.label}`);
      }))];
  }

  /** A row's paths on one side: the shortest, and the rest behind "+N more" so a busy variable stays one line. */
  function routesCell(entry, paths, side) {
    const cell = el("td", { class: "dag-table-routes" });
    if (!paths.length) { cell.append(el("span", { class: "dag-table-empty", text: "–" })); return cell; }
    const key = `${entry.id}\u0000${side}`;
    const draw = () => {
      const open = expandedRoutes.has(key);
      cell.replaceChildren(...(open ? paths : paths.slice(0, 1)).map(path => compactPath(path, entry.id)));
      if (paths.length > 1) {
        // The toggle ends the last path's line rather than taking a line of its own.
        cell.lastElementChild.append(button(open ? "Show fewer" : `+${paths.length - 1} more`,
          open ? `Show only the shortest path for ${entry.label}` : `Show ${paths.length - 1} more paths for ${entry.label}`,
          () => { if (open) expandedRoutes.delete(key); else expandedRoutes.add(key); draw(); },
          { class: "btn btn--ghost dag-table-action dag-table-more-routes", "aria-expanded": open ? "true" : "false" }));
      }
    };
    draw();
    return cell;
  }

  /** A confounder's or collider's status: a menu, and a note when it is "Other". Saved on change. */
  function statusCell(entry, spec) {
    const select = el("select", { class: "select-input dag-table-status", "data-group-id": entry.id, "aria-label": `Status for ${entry.label}` },
      ...spec.options.map(option => el("option", { value: option.value, title: option.title, text: option.label })));
    if (entry.status.status === "other") select.append(el("option", { value: "other", text: "Other (previous status)" }));
    select.value = entry.status.status;
    select.classList.toggle("is-unaddressed", entry.status.status === "unaddressed");
    const note = el("span", { class: "small-note", text: ["removed_other", "other"].includes(entry.status.status) && entry.status.text ? `Private note: ${entry.status.text}` : "" });
    select.addEventListener("change", () => {
      const status = select.value;
      select.value = entry.status.status;
      onSetStatus(spec.kind, entry.id, status);
    });
    // A tooltip needs a hover, so on a touch screen the warning is a button that shows its text in the cell.
    const warned = spec.kind === "exclusion" && entry.status.status === "explicitly_controlled";
    const warningText = warned ? el("span", { class: "small-note review-warning-text", text: CONTROL_WARNING }) : null;
    if (warningText) warningText.hidden = true;
    const warning = warned
      ? el("button", { type: "button", class: "review-warning", title: CONTROL_WARNING, "aria-label": `Warning: ${CONTROL_WARNING}`, "aria-expanded": "false", text: "⚠" }) : null;
    warning?.addEventListener("click", () => {
      warningText.hidden = !warningText.hidden;
      warning.setAttribute("aria-expanded", String(!warningText.hidden));
    });
    const edit = entry.status.status === "removed_other" ? el("button", { type: "button", class: "btn btn--ghost btn--sm", text: "Edit reason" }) : null;
    edit?.addEventListener("click", () => onSetStatus(spec.kind, entry.id, "removed_other"));
    return el("td", { class: "dag-table-status-cell" }, select, note, warning, warningText, edit);
  }

  /** Identify: one row per candidate with its paths, laid out like Explore's table. */
  function diagnosticTable() {
    const { title, headers, sections, status: statusSpec } = model.diagnostic;
    const total = sections.reduce((sum, section) => sum + section.rows.length, 0);
    const caption = el("caption", {}, el("strong", { text: title }),
      el("span", { class: "dag-table-caption-note", text: " · Click a variable for its definition, a link for its evidence." }));
    const order = { papers: (a, b) => (b.papers ?? -1) - (a.papers ?? -1) || String(a.label ?? "").localeCompare(String(b.label ?? "")),
      concepts: (a, b) => b.concepts - a.concepts || String(a.label ?? "").localeCompare(String(b.label ?? "")) }[diagnosticSort];
    // Rows start in name order; Papers and Concepts sort within each section, and a second click restores it.
    const sortHeader = (text, key, numeric) => {
      const active = diagnosticSort === key;
      if (!key) return el("th", { scope: "col", class: numeric ? "dag-table-number" : null, text });
      return el("th", { scope: "col", class: numeric ? "dag-table-number" : null, "aria-sort": active ? "descending" : "none" },
        button(`${text}${active ? " ↓" : ""}`, active ? `${text}: sorted; click to sort by name` : `Sort by ${text.toLowerCase()}`,
          () => { diagnosticSort = active ? null : key; render(); },
          { class: "btn btn--ghost dag-table-action dag-table-sort", "data-sort-key": key }));
    };
    const body = el("tbody", {});
    const items = sections.flatMap(section => [{ heading: section.title, count: section.rows.length },
      ...(order ? section.rows.slice().sort(order) : section.rows)]);
    pendingFills.push({ body, items: items.slice(0, shownRows + sections.length), build: entry => {
      if (entry.heading) {
        return [el("tr", { class: "dag-table-section" },
          el("th", { scope: "colgroup", colspan: headers.length + 3 + (statusSpec ? 1 : 0), text: `${entry.heading} (${entry.count})` }))];
      }
      return [el("tr", { "data-row-id": entry.id },
        el("th", { scope: "row", class: "dag-table-variable" },
          button(entry.label, `Open the definition of ${entry.label}`, () => onOpenVariable(entry.id),
            { class: "btn btn--ghost dag-table-action dag-table-node", "data-group-id": entry.id })),
        ...entry.sides.map((paths, side) => routesCell(entry, paths, side)),
        el("td", { class: "dag-table-number", text: entry.papers === null ? "–" : String(entry.papers) }),
        el("td", { class: "dag-table-number", text: String(entry.concepts) }),
        statusSpec ? statusCell(entry, statusSpec) : null)];
    } });
    const table = el("table", { class: "dag-table dag-table-explore dag-table-diagnostic", id: "dagPathsTable", "data-path-count": model.pathCount },
      caption,
      el("thead", {}, el("tr", {}, sortHeader("Variable"), ...headers.map(text => sortHeader(text)),
        sortHeader("Papers", "papers", true), sortHeader("Concepts", "concepts", true),
        statusSpec ? sortHeader("Status") : null)),
      body);
    return [table, more(shownRows, total, "variables", () => { shownRows += TABLE_PAGE_SIZE; render(); })];
  }

  function otherLinksTable() {
    if (!model.otherLinks.length) return [];
    const body = el("tbody", {});
    pendingFills.push({ body, items: model.otherLinks.slice(0, shownOther), build: row => [el("tr", { "data-row-id": row.id },
      pathCell(row.chains[0]),
      el("td", { class: "dag-table-number", text: row.papers === null ? "–" : String(row.papers) }))] });
    const table = el("table", { class: "dag-table", id: "dagOtherLinksTable" },
      el("caption", { text: `Other links in this view (${model.otherLinks.length})` }),
      el("thead", {}, el("tr", {}, headerCell("Link"), headerCell("Papers"))),
      body);
    return [table, more(shownOther, model.otherLinks.length, "links", () => { shownOther += TABLE_PAGE_SIZE; render(); })];
  }

  function variablesTable() {
    const rows = model.variableRows.slice().sort(VARIABLE_SORTS[variableSort]);
    const sorter = (text, key) => headerCell(text, true, variableSort === key, () => { variableSort = key; render(); });
    const body = el("tbody", {});
    pendingFills.push({ body, items: rows.slice(0, shownVariables), build: row => {
      const selected = row.groupId === selection.groupId;
      return [el("tr", { "data-group-id": row.groupId, class: selected ? "selected" : "", "aria-current": selected ? "true" : null },
        el("td", {}, button(row.label, `Open the definition of ${row.label}`, () => onOpenVariable(row.groupId),
          { "aria-pressed": selected ? "true" : "false" })),
        el("td", { text: row.role }),
        el("td", { class: "dag-table-number", text: String(row.variables) }),
        el("td", { class: "dag-table-number", text: String(row.links) }))];
    } });
    const table = el("table", { class: "dag-table", id: "dagVariablesTable" },
      el("caption", { text: `Variables in this view (${rows.length})` }),
      el("thead", {}, el("tr", {}, sorter("Variable", "label"), headerCell("Role"), sorter("Variables", "variables"), sorter("Links", "links"))),
      body);
    return [table, more(shownVariables, rows.length, "variables", () => { shownVariables += TABLE_PAGE_SIZE; render(); })];
  }

  let renderToken = 0;
  let pendingFills = [];
  const ROW_CHUNK = 40;

  // A sort header's accessible name changes once it is active, so it is found again by its sort key.
  function restoreFocus(label, sortKey) {
    if (sortKey) container.querySelector(`button[data-sort-key="${sortKey}"]`)?.focus();
    else if (label) [...container.querySelectorAll("button, select, input")].find(node => node.getAttribute("aria-label") === label)?.focus();
  }

  /**
   * Builds the tables a screenful of rows at a time, the first chunk at once and the rest in later tasks, so a
   * big table never holds a slow phone in one long task. Resolves when every row is in (or a newer render took over).
   */
  async function render() {
    const focused = doc.activeElement && container.contains(doc.activeElement)
      ? doc.activeElement.getAttribute("aria-label") : null;
    const focusedSort = doc.activeElement && container.contains(doc.activeElement)
      ? doc.activeElement.getAttribute("data-sort-key") : null;
    const scroll = container.scrollTop;
    const token = ++renderToken;
    pendingFills = [];
    // Explore's table already names each variable once, so it has no separate variables table.
    // Identify's diagnostics follow Explore's layout: no summary line and no separate variables table.
    const tables = model.explore ? [...definitionBlock(), ...studyTable(), ...exploreTable(), ...otherLinksTable()]
      : model.diagnostic ? [...studyLine(), ...diagnosticTable(), ...otherLinksTable()]
        : [...studyTable(), ...pathsTable(), ...otherLinksTable(), ...variablesTable()];
    const summary = model.explore || model.diagnostic ? null : el("p", { class: "dag-table-summary", role: "status", text: model.variableRows.length
      ? `${model.variableRows.length} variables, ${model.pathCount} paths and ${model.otherLinks.length} other links, the same as the graph. Arrows open the evidence for a link.`
      : "Nothing to show yet." });
    // Anything left out is null, which replaceChildren would print as the text "null".
    container.replaceChildren(...[summary, ...tables].filter(Boolean));
    const fills = pendingFills;
    for (const { body, items, build } of fills) {
      for (let at = 0; at < items.length; at += ROW_CHUNK) {
        if (at || body !== fills[0].body) await new Promise(resolve => setTimeout(resolve, 0));
        if (token !== renderToken) return;
        const fragment = doc.createDocumentFragment();
        for (const item of items.slice(at, at + ROW_CHUNK)) fragment.append(...build(item));
        body.append(fragment);
      }
    }
    container.scrollTop = scroll;
    restoreFocus(focused, focusedSort);
  }

  return {
    update(next) {
      // A render with nothing new (a late data load, a repeated filter) keeps the table, and the reader's place in it.
      const signature = JSON.stringify([next.headers, next.candidateHeader, next.rows, next.explore, next.diagnostic, next.study, next.otherLinks, next.variableRows,
        [...next.linkById].map(([id, link]) => [id, link.direction_type])]);
      if (signature === shownSignature) { model = next; return Promise.resolve(); }
      shownSignature = signature;
      model = next;
      shownRows = shownOther = shownVariables = TABLE_PAGE_SIZE;
      return render();
    },
    select(next) {
      const changed = next.edgeId !== selection.edgeId || next.groupId !== selection.groupId;
      selection = { edgeId: next.edgeId || null, groupId: next.groupId || null };
      if (!changed) return;
      for (const arrow of container.querySelectorAll(":is(.dag-table-arrow, .dag-table-link)[data-edge-id]")) {
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
