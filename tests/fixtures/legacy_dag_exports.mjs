// Frozen pre-extraction export formatter. Metadata resolves immediately in input
// order; the production formatter now guarantees that order for citation keys.
export async function legacyExports(input, metadata, timestamp = "2026-09-09T12:00:00Z", svg = null) {
  const state = { ...input, project: structuredClone(input.project),
    data: { cache_compatibility: input.cacheCompatibility } };
  const nowIso = () => timestamp;
  const groupById = id => state.project.groups.find(g => g.group_id === id);
  const dagGroups = () => state.project.groups.filter(g => g.variable_ids?.length);
  const rejectedVariableEntries = () => input.rejectedVariables;
  const rejectedVariableIdSet = () => new Set(input.hiddenVariableIds);
  const Date = { now: () => 123 };
  const aggregateGroupLinks = () => {};
  const computeVisibleLinks = () => {};
  const fetchCrossRef = async doi => metadata.get(doi);
  const METHOD_DOI = "10.31235/osf.io/zr5vf_v1";
  const METHOD_BIB_KEY = "dagbuilder";
  const setExportBusy = () => {};
  const getDagSvgString = () => svg;
  const downloads = new Map();
  const downloadBlob = (data, name) => downloads.set(name, data);
  const downloadJson = downloadBlob;
  const makeZip = files => files;
function isDoi(id) {
  return typeof id === "string" && /^10\.\d{4,}\/\S+/.test(id.trim());
}

function makeBibKey(data, doi, usedKeys) {
  const family = (data.author?.[0]?.family || "").toLowerCase().replace(/[^a-z]/g, "");
  const year = data.published?.["date-parts"]?.[0]?.[0] || data["published-online"]?.["date-parts"]?.[0]?.[0] || "";
  let base = family && year ? `${family}${year}` : doi.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 20);
  let key = base, suffix = 98; // 98 = 'b'
  while (usedKeys.has(key)) key = base + String.fromCharCode(suffix++);
  usedKeys.add(key);
  return key;
}

function makeBibEntry(data, doi, key) {
  const authors = (data.author || []).map(a => [a.family, a.given].filter(Boolean).join(", ")).join(" and ");
  const year = data.published?.["date-parts"]?.[0]?.[0] || data["published-online"]?.["date-parts"]?.[0]?.[0] || "";
  const title = (data.title || [])[0] || "";
  const journal = (data["container-title"] || [])[0] || "";
  const volume = data.volume || "";
  const issue = data.issue || "";
  const pages = data.page || "";
  const type = data.type === "journal-article" ? "article" : "misc";
  return [
    `@${type}{${key},`,
    authors   ? `  author  = {${authors}},`  : null,
    title     ? `  title   = {${title}},`    : null,
    journal   ? `  journal = {${journal}},`  : null,
    year      ? `  year    = {${year}},`     : null,
    volume    ? `  volume  = {${volume}},`   : null,
    issue     ? `  number  = {${issue}},`    : null,
    pages     ? `  pages   = {${pages}},`    : null,
    doi       ? `  doi     = {${doi}},`      : null,
    doi       ? `  url     = {https://doi.org/${doi}},` : null,
    "}",
  ].filter(Boolean).join("\n");
}

function collectAllDagDois() {
  const dois = new Set();
  for (const link of (state.visibleLinks || [])) {
    const rawIds = [...link.a_to_b_raw_link_ids, ...link.b_to_a_raw_link_ids];
    for (const id of rawIds) {
      const lr = state.rawLinksById.get(id);
      if (lr && isDoi(lr.paper_id)) dois.add(lr.paper_id.trim());
    }
  }
  return [...dois];
}

async function buildBibText(dois) {
  const usedKeys = new Set([METHOD_BIB_KEY]);
  const keyMap = new Map();

  const methodData = await fetchCrossRef(METHOD_DOI);
  const methodEntry = methodData
    ? makeBibEntry(methodData, METHOD_DOI, METHOD_BIB_KEY)
    : `@misc{${METHOD_BIB_KEY},\n  doi = {${METHOD_DOI}},\n  url = {https://doi.org/${METHOD_DOI}},\n}`;

  const paperEntries = await Promise.all(dois.map(async doi => {
    const data = await fetchCrossRef(doi);
    if (!data) {
      let base = doi.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 20);
      let k = base, suffix = 98;
      while (usedKeys.has(k)) k = base + String.fromCharCode(suffix++);
      usedKeys.add(k);
      keyMap.set(doi, k);
      return `% Could not fetch: ${doi}\n@misc{${k},\n  doi = {${doi}},\n  url = {https://doi.org/${doi}},\n}`;
    }
    const key = makeBibKey(data, doi, usedKeys);
    keyMap.set(doi, key);
    return makeBibEntry(data, doi, key);
  }));

  return { bibText: [methodEntry, ...paperEntries].join("\n\n"), keyMap };
}

function buildLinksTable(fmt, keyMap) {
  const links = state.visibleLinks || [];
  if (!links.length) return fmt === "md" ? "_No links._\n" : "\\textit{No links.}\n";

  const rows = links.map(link => {
    const { sourceLabel, targetLabel, arrow } = directedGroupLabels(link, "↔");
    const rawIds = [...new Set([...link.a_to_b_raw_link_ids, ...link.b_to_a_raw_link_ids])];
    const dois = [...new Set(rawIds.map(id => state.rawLinksById.get(id)?.paper_id).filter(isDoi))];
    const manual = link.is_manual ? ["manual"] : [];
    if (fmt === "md") {
      const cites = dois.map(d => `[@${keyMap?.get(d.trim()) || d.trim()}]`);
      const src = [...cites, ...manual].join("; ") || "—";
      return `| ${escapeHtml(sourceLabel)} | ${escapeHtml(targetLabel)} | ${arrow} | ${src} |`;
    } else {
      const cites = dois.map(d => `\\citep{${keyMap?.get(d.trim()) || d.trim().replace(/[^a-zA-Z0-9_.\-]/g, "_")}}`);
      const src = [...cites, ...manual].join("; ") || "---";
      return `  ${texEscape(sourceLabel)} & ${texEscape(targetLabel)} & ${arrow} & ${src} \\\\`;
    }
  });

  if (fmt === "md") {
    return [
      "| Source | Target | Direction | Papers |",
      "|--------|--------|:---------:|--------|",
      ...rows,
    ].join("\n") + "\n";
  } else {
    return [
      "\\begin{longtable}{lllp{7cm}}",
      "\\toprule",
      "Source & Target & Dir & Papers \\\\",
      "\\midrule",
      "\\endhead",
      ...rows,
      "\\bottomrule",
      "\\end{longtable}",
    ].join("\n") + "\n";
  }
}

function buildExcludedLinksTable(fmt) {
  const excluded = Object.values(state.project.link_decisions || {})
    .filter(d => d.display_status === "excluded");
  if (!excluded.length) return null;

  const rows = excluded.map(d => {
    const link = state.project.links.find(l => l.edge_id === d.edge_id);
    const a = link ? groupById(link.group_a) : null;
    const b = link ? groupById(link.group_b) : null;
    const aLabel = a?.label || d.edge_id.split("->")[0] || d.edge_id;
    const bLabel = b?.label || d.edge_id.split("->")[1] || "";
    const reason = d.exclude_reason || "(no reason recorded)";
    if (fmt === "md") {
      return `| ${escapeHtml(aLabel)} | ${escapeHtml(bLabel)} | ${escapeHtml(reason)} |`;
    } else {
      return `  ${texEscape(aLabel)} & ${texEscape(bLabel)} & ${texEscape(reason)} \\\\`;
    }
  });

  if (fmt === "md") {
    return [
      "| Source | Target | Reason for exclusion |",
      "|--------|--------|----------------------|",
      ...rows,
    ].join("\n") + "\n";
  } else {
    return [
      "\\begin{longtable}{llp{9cm}}",
      "\\toprule",
      "Source & Target & Reason for exclusion \\\\",
      "\\midrule",
      "\\endhead",
      ...rows,
      "\\bottomrule",
      "\\end{longtable}",
    ].join("\n") + "\n";
  }
}

function texEscape(s) {
  return (s || "").replace(/[&%$#_{}~^\\]/g, m => `\\${m === "\\" ? "textbackslash{}" : m}`);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function directedGroupLabels(link, bidirectionalArrow = "↔") {
  const a = groupById(link.group_a);
  const b = groupById(link.group_b);
  const aLabel = a?.label || link.group_a;
  const bLabel = b?.label || link.group_b;
  if (link.direction_type === "B_TO_A") {
    return { sourceLabel: bLabel, targetLabel: aLabel, arrow: "→" };
  }
  return {
    sourceLabel: aLabel,
    targetLabel: bLabel,
    arrow: link.direction_type === "BIDIRECTIONAL" ? bidirectionalArrow : "→",
  };
}

async function exportMd() {
  setExportBusy(true);
  const dois = collectAllDagDois();
  const { bibText, keyMap } = await buildBibText(dois);
  const svgStr = getDagSvgString();
  const hasGraph = (state.visibleLinks || []).length > 0;
  const ivLabel = groupById(state.project?.iv_group_id)?.label || "Independent variable";
  const dvLabel = groupById(state.project?.dv_group_id)?.label || "Dependent variable";

  const md = [
    `---`,
    `title: "Working Causal Map"`,
    `bibliography: references.bib`,
    `link-citations: true`,
    `---`,
    ``,
    `**IV:** ${ivLabel}  `,
    `**DV:** ${dvLabel}`,
    ``,
    `*Constructed with DAG Builder [@${METHOD_BIB_KEY}].*`,
    ``,
    `## Causal Graph`,
    ``,
    svgStr ? `![Causal DAG](dag.svg)`
      : hasGraph ? `*(Graph figure export is not yet available — the causal structure is listed in the Causal Links table below.)*`
        : `*(No DAG to display — create groups and add edges first.)*`,
    ``,
    `## Causal Links`,
    ``,
    buildLinksTable("md", keyMap),
    ...(buildExcludedLinksTable("md") ? [
      `## Excluded Links`,
      ``,
      `The following edges were reviewed and excluded from the working causal map.`,
      ``,
      buildExcludedLinksTable("md"),
    ] : []),
    `# References`,
    ``,
  ].join("\n");

  const files = [{ name: "dag.md", data: md }, { name: "references.bib", data: bibText }];
  if (svgStr) files.push({ name: "dag.svg", data: svgStr });
  setExportBusy(false);
  downloadBlob(makeZip(files), "causal_map.zip");
}

async function exportTex() {
  setExportBusy(true);
  const dois = collectAllDagDois();
  const { bibText, keyMap } = await buildBibText(dois);
  const svgStr = getDagSvgString();
  const ivLabel = groupById(state.project?.iv_group_id)?.label || "Independent variable";
  const dvLabel = groupById(state.project?.dv_group_id)?.label || "Dependent variable";

  const tex = [
    `\\documentclass{article}`,
    `\\usepackage[utf8]{inputenc}`,
    `\\usepackage{graphicx}`,
    `\\usepackage{booktabs}`,
    `\\usepackage{longtable}`,
    `\\usepackage{hyperref}`,
    `\\usepackage{natbib}`,
    `% To compile: pdflatex dag.tex && bibtex dag && pdflatex dag.tex && pdflatex dag.tex`,
    `% dag.svg must be converted to dag.pdf first (e.g. via Inkscape or rsvg-convert)`,
    ``,
    `\\title{Working Causal Map}`,
    `\\author{}`,
    `\\date{\\today}`,
    ``,
    `\\begin{document}`,
    `\\maketitle`,
    ``,
    `\\noindent\\textbf{IV:} ${texEscape(ivLabel)}\\\\`,
    `\\textbf{DV:} ${texEscape(dvLabel)}`,
    ``,
    `This causal map was constructed using the DAG Builder method \\citep{${METHOD_BIB_KEY}}.`,
    ``,
    `\\section{Causal Graph}`,
    ``,
    svgStr
      ? `\\begin{figure}[h]\n\\centering\n\\includegraphics[width=\\textwidth]{dag.pdf}\n\\caption{Working causal map: ${texEscape(ivLabel)} $\\rightarrow$ ${texEscape(dvLabel)}}\n\\end{figure}`
      : ((state.visibleLinks || []).length
        ? `\\textit{Graph figure export is not yet available; the causal structure is listed in the Causal Links table below.}`
        : `\\textit{No DAG to display --- create groups and add edges first.}`),
    ``,
    `\\section{Causal Links}`,
    ``,
    buildLinksTable("tex", keyMap),
    ``,
    ...(buildExcludedLinksTable("tex") ? [
      `\\section{Excluded Links}`,
      ``,
      `The following edges were reviewed and excluded from the working causal map.`,
      ``,
      buildExcludedLinksTable("tex"),
      ``,
    ] : []),
    `\\bibliographystyle{plainnat}`,
    `\\bibliography{references}`,
    ``,
    `\\end{document}`,
  ].join("\n");

  const files = [{ name: "dag.tex", data: tex }, { name: "references.bib", data: bibText }];
  if (svgStr) files.push({ name: "dag.svg", data: svgStr });
  setExportBusy(false);
  downloadBlob(makeZip(files), "causal_map_latex.zip");
}

function projectPayload() {
  return {
    schema_version: "dag-builder-project-v1",
    saved_at: nowIso(),
    ...state.project,
    selectedUoa: state.selectedUoa,
    uoaFilterEnabled: state.uoaFilterEnabled,
    phase: state.phase,
    workflowMode: state.workflowMode,
    changingAnchorSide: state.changingAnchorSide,
    variableLayoutSource: state.variableLayoutSource,
    dagLayoutMode: state.dagLayoutMode,
    seeds: {
      iv: [...state.seeds.iv],
      dv: [...state.seeds.dv],
    },
  };
}

function exportReusableGroupingSet() {
  const groups = state.project.groups
    .filter((g) => g.variable_ids?.length && !["iv", "dv"].includes(g.type))
    .map((g) => ({ group_id: g.group_id, label: g.label, variable_ids: g.variable_ids.slice(), source: "project_export", notes: g.notes || "" }));
  const payload = {
    schema_version: "groupings-v1",
    grouping_set_id: `project_grouping_${Date.now()}`,
    label: "Project groups",
    description: "Reusable grouping set exported from non-IV/DV project groups.",
    cache_compatibility: state.data.cache_compatibility,
    groups,
    rejected_variables: rejectedVariableEntries().map((entry) => ({
      variable_id: entry.variable_id,
      member_variable_ids: (entry.member_variable_ids || []).slice(),
      label: entry.label || "",
      reason: entry.reason || "low_quality",
      flagged_at: entry.flagged_at || nowIso(),
      previous_group_ids: (entry.previous_group_ids || []).slice(),
    })),
    hidden_variable_ids: [...rejectedVariableIdSet()],
  };
  state.project.grouping_exports.push({ grouping_set_id: payload.grouping_set_id, exported_at: nowIso() });
  downloadJson(payload, "grouping_set.json");
}

function exportWorkingMap() {
  aggregateGroupLinks();
  computeVisibleLinks();
  const visibleGroupIds = new Set([
    state.project.iv_group_id,
    state.project.dv_group_id,
    ...state.visibleLinks.flatMap((link) => [link.group_a, link.group_b]),
  ]);
  downloadJson({
    schema_version: "working-causal-map-v1",
    exported_at: nowIso(),
    iv_group_id: state.project.iv_group_id,
    dv_group_id: state.project.dv_group_id,
    groups: dagGroups().filter((group) => visibleGroupIds.has(group.group_id)),
    links: state.visibleLinks,
    manual_edges: state.project.manual_edges.filter((e) => !e.deleted),
    rejected_variables: rejectedVariableEntries(),
    hidden_variable_ids: [...rejectedVariableIdSet()],
    allows_bidirectional_links: true,
    allows_cycles: true,
  }, "working_causal_map.json");
}
  const payload = structuredClone(projectPayload());
  await exportMd();
  await exportTex();
  exportReusableGroupingSet();
  exportWorkingMap();
  return { md: downloads.get("causal_map.zip"), tex: downloads.get("causal_map_latex.zip"),
    grouping: downloads.get("grouping_set.json"), working: downloads.get("working_causal_map.json"),
    payload, bibliography: await buildBibText(collectAllDagDois()) };
}
function crc32(data) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })());
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
export function legacyZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameB = enc.encode(name);
    const fileB = typeof data === "string" ? enc.encode(data) : data;
    const crc = crc32(fileB);
    const local = new Uint8Array(30 + nameB.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, fileB.length, true); lv.setUint32(22, fileB.length, true);
    lv.setUint16(26, nameB.length, true);
    local.set(nameB, 30);
    parts.push(local, fileB);
    const cd = new Uint8Array(46 + nameB.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, fileB.length, true); cv.setUint32(24, fileB.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameB, 46);
    central.push(cd);
    offset += local.length + fileB.length;
  }
  const cdSize = central.reduce((s, e) => s + e.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, eocd], { type: "application/zip" });
}
