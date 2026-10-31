import { directedGroupLabels } from "./dag_exports.mjs";

// A table of exactly what the graph draws: the shown variables and the links
// between them. It carries the graph's interactions (open a variable's
// definition, open a link's evidence) as ordinary buttons, so it also serves
// keyboard and screen-reader use and graphs too dense to read.

export const TABLE_PAGE_SIZE = 200;
export const STUDY_ROW_PREFIX = "study:";

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

function variableCount(group) {
  return group.variable_ids?.length || group.member_count || 0;
}

/**
 * Rows for the two tables. `roleFor(group)` names a variable's part in the
 * current view (Ind var, focus, confounder ...). `studyLinks` are the drawn
 * study-design relationships, which have no evidence links of their own.
 */
export function dagTableModel({ groups, links, roleFor = () => "", studyLinks = [] }) {
  const byId = new Map(groups.map(group => [group.group_id, group]));
  const linkCounts = new Map();
  const linkRows = links.map(link => {
    const { sourceLabel, targetLabel, arrow } = directedGroupLabels(link, groups, "↔");
    const reversed = link.direction_type === "B_TO_A";
    for (const id of [link.group_a, link.group_b]) linkCounts.set(id, (linkCounts.get(id) || 0) + 1);
    return {
      edgeId: link.edge_id, kind: "link",
      sourceId: reversed ? link.group_b : link.group_a, targetId: reversed ? link.group_a : link.group_b,
      source: sourceLabel, target: targetLabel,
      direction: arrow === "↔" ? "Both directions" : "Causes", arrow,
      papers: linkPapers(link),
    };
  });
  const studyRows = studyLinks.filter(item => byId.has(item.sourceId) && byId.has(item.targetId)).map(item => ({
    edgeId: item.edgeId, kind: "study", sourceId: item.sourceId, targetId: item.targetId,
    source: byId.get(item.sourceId).label, target: byId.get(item.targetId).label,
    direction: item.note, arrow: "→", papers: null,
  }));
  const variableRows = groups.map(group => ({
    groupId: group.group_id, label: group.label, role: roleFor(group),
    variables: variableCount(group), links: linkCounts.get(group.group_id) || 0,
  }));
  return { linkRows: [...studyRows, ...linkRows], variableRows };
}

const SORTS = {
  source: (a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
  target: (a, b) => a.target.localeCompare(b.target) || a.source.localeCompare(b.source),
  papers: (a, b) => (b.papers ?? -1) - (a.papers ?? -1) || SORTS.source(a, b),
};
const VARIABLE_SORTS = {
  label: (a, b) => a.label.localeCompare(b.label),
  links: (a, b) => b.links - a.links || a.label.localeCompare(b.label),
  variables: (a, b) => b.variables - a.variables || a.label.localeCompare(b.label),
};

export function sortedLinkRows(rows, sort) {
  // Study relationships stay first: they are the question being asked.
  const study = rows.filter(row => row.kind === "study");
  const rest = rows.filter(row => row.kind !== "study");
  return [...study, ...(SORTS[sort] ? rest.sort(SORTS[sort]) : rest)];
}

export function createDagTable({ container, onOpenVariable, onOpenEvidence }) {
  const doc = container.ownerDocument;
  let model = { linkRows: [], variableRows: [] };
  let selection = { edgeId: null, groupId: null };
  let linkSort = "papers", variableSort = "links";
  let shownLinks = TABLE_PAGE_SIZE, shownVariables = TABLE_PAGE_SIZE;

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

  function header(columns, sort, setSort) {
    return el("thead", {}, el("tr", {}, ...columns.map(({ key, text, sortable }) => {
      if (!sortable) return el("th", { scope: "col", text });
      const active = sort === key;
      const sorter = button(text, `${text}: sort the table by this column`, () => setSort(key));
      return el("th", { scope: "col", "aria-sort": active ? "descending" : "none" }, sorter);
    })));
  }

  function more(shown, total, noun, expand) {
    if (shown >= total) return null;
    return el("p", { class: "dag-table-more" }, button(`Show ${Math.min(TABLE_PAGE_SIZE, total - shown)} more ${noun}`,
      `Show more ${noun}; ${total - shown} not yet shown`, expand), el("span", { text: ` Showing ${shown} of ${total}.` }));
  }

  function linksTable() {
    const rows = sortedLinkRows(model.linkRows.slice(), linkSort);
    const table = el("table", { class: "dag-table", id: "dagLinksTable" },
      el("caption", { text: `Links in this view (${model.linkRows.length})` }),
      header([{ key: "source", text: "From", sortable: true }, { key: "direction", text: "Direction" },
        { key: "target", text: "To", sortable: true }, { key: "papers", text: "Papers", sortable: true },
        { key: "evidence", text: "Evidence" }], linkSort, key => { linkSort = key; render(); }),
      el("tbody", {}, ...rows.slice(0, shownLinks).map(row => {
        const selected = row.edgeId === selection.edgeId;
        const tr = el("tr", { "data-edge-id": row.edgeId, class: selected ? "selected" : "", "aria-current": selected ? "true" : null });
        tr.append(
          el("td", {}, button(row.source, `Open the definition of ${row.source}`, () => onOpenVariable(row.sourceId))),
          el("td", {}, el("span", { "aria-hidden": "true", text: row.arrow }), el("span", { class: "dag-table-direction", text: ` ${row.direction}` })),
          el("td", {}, button(row.target, `Open the definition of ${row.target}`, () => onOpenVariable(row.targetId))),
          el("td", { class: "dag-table-number", text: row.papers === null ? "–" : String(row.papers) }),
          el("td", {}, button("Evidence", `View the evidence for ${row.source} to ${row.target}`,
            () => onOpenEvidence(row.edgeId), { "aria-pressed": selected ? "true" : "false" })));
        return tr;
      })));
    return [table, more(shownLinks, rows.length, "links", () => { shownLinks += TABLE_PAGE_SIZE; render(); })];
  }

  function variablesTable() {
    const rows = model.variableRows.slice().sort(VARIABLE_SORTS[variableSort]);
    const table = el("table", { class: "dag-table", id: "dagVariablesTable" },
      el("caption", { text: `Variables in this view (${rows.length})` }),
      header([{ key: "label", text: "Variable", sortable: true }, { key: "role", text: "Role" },
        { key: "variables", text: "Variables", sortable: true }, { key: "links", text: "Links", sortable: true }],
      variableSort, key => { variableSort = key; render(); }),
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
      model.variableRows.length ? el("p", { class: "dag-table-summary", role: "status",
        text: `${model.variableRows.length} variables and ${model.linkRows.length} links, the same as the graph.` })
        : el("p", { class: "dag-table-summary", role: "status", text: "Nothing to show yet." }),
      ...linksTable(), ...variablesTable());
    container.scrollTop = scroll;
    // Re-sorting or selecting rebuilds the table; keep the keyboard user where they were.
    if (focused) [...container.querySelectorAll("button")].find(node => node.getAttribute("aria-label") === focused)?.focus();
  }

  return {
    update(next) {
      model = next;
      shownLinks = shownVariables = TABLE_PAGE_SIZE;
      render();
    },
    select(next) {
      const changed = next.edgeId !== selection.edgeId || next.groupId !== selection.groupId;
      selection = { edgeId: next.edgeId || null, groupId: next.groupId || null };
      if (!changed) return;
      for (const row of container.querySelectorAll("tr[data-edge-id]")) {
        const selected = row.dataset.edgeId === selection.edgeId;
        row.classList.toggle("selected", selected);
        if (selected) row.setAttribute("aria-current", "true"); else row.removeAttribute("aria-current");
        row.querySelector(".dag-table-action[aria-pressed]")?.setAttribute("aria-pressed", selected ? "true" : "false");
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
