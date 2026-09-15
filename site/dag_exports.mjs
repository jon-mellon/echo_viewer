import { PROJECT_FORMAT_VERSION, WORKING_MAP_FORMAT_VERSION } from "./app_contracts.mjs";
import { escapeHtml } from "./text_utils.mjs";

/** @typedef {import("./app_contracts.mjs").SerializedProjectPayload} SerializedProjectPayload */

// Pure export generation. The caller supplies a snapshot, metadata and timestamps.
// Returned file records contain content only; fetching and downloading stay in the UI.
export const METHOD_DOI = "10.31235/osf.io/zr5vf_v1";
export const METHOD_BIB_KEY = "dagbuilder";

function normalizedLatexText(value) {
  return String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "");
}

function isDoi(id) {
  return typeof id === "string" && /^10\.\d{4,}\/\S+$/.test(id.trim());
}

export function escapeBibTexValue(value) {
  const replacements = new Map([
    ["\\", "{\\textbackslash}"], ["{", "\\{"], ["}", "\\}"],
    ["#", "\\#"], ["%", "\\%"], ["&", "\\&"], ["_", "\\_"], ["$", "\\$"],
    ["~", "{\\textasciitilde}"], ["^", "{\\textasciicircum}"],
  ]);
  return normalizedLatexText(value)
    .replace(/[^\x00-\x7F]/g, "?")
    .replace(/[\\{}#%&_$~^]/g, character => replacements.get(character))
    .replace(/\s+/g, " ")
    .trim();
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
  const authors = (data.author || []).map(a => (
    [a.family, a.given].filter(Boolean).map(escapeBibTexValue).join(", ")
  )).join(" and ");
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
    title     ? `  title   = {${escapeBibTexValue(title)}},`    : null,
    journal   ? `  journal = {${escapeBibTexValue(journal)}},`  : null,
    year      ? `  year    = {${escapeBibTexValue(year)}},`     : null,
    volume    ? `  volume  = {${escapeBibTexValue(volume)}},`   : null,
    issue     ? `  number  = {${escapeBibTexValue(issue)}},`    : null,
    pages     ? `  pages   = {${escapeBibTexValue(pages)}},`    : null,
    doi       ? `  doi     = {${escapeBibTexValue(doi)}},`      : null,
    doi       ? `  url     = {${escapeBibTexValue(`https://doi.org/${doi}`)}},` : null,
    "}",
  ].filter(Boolean).join("\n");
}

export function collectAllDagDois({ visibleLinks, rawLinksById }) {
  const dois = new Set();
  for (const link of (visibleLinks || [])) {
    const rawIds = [...link.a_to_b_raw_link_ids, ...link.b_to_a_raw_link_ids];
    for (const id of rawIds) {
      const lr = rawLinksById.get(id);
      if (lr && isDoi(lr.paper_id)) dois.add(lr.paper_id.trim());
    }
  }
  return [...dois];
}

export function buildBibText(dois, metadataByDoi) {
  const usedKeys = new Set([METHOD_BIB_KEY]);
  const keyMap = new Map();

  const methodData = metadataByDoi.get(METHOD_DOI);
  const methodEntry = methodData
    ? makeBibEntry(methodData, METHOD_DOI, METHOD_BIB_KEY)
    : `@misc{${METHOD_BIB_KEY},\n  doi = {${escapeBibTexValue(METHOD_DOI)}},\n  url = {${escapeBibTexValue(`https://doi.org/${METHOD_DOI}`)}},\n}`;

  const paperEntries = dois.map(doi => {
    const data = metadataByDoi.get(doi);
    if (!data) {
      let base = doi.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 20);
      let k = base, suffix = 98;
      while (usedKeys.has(k)) k = base + String.fromCharCode(suffix++);
      usedKeys.add(k);
      keyMap.set(doi, k);
      return `% Could not fetch: ${doi}\n@misc{${k},\n  doi = {${escapeBibTexValue(doi)}},\n  url = {${escapeBibTexValue(`https://doi.org/${doi}`)}},\n}`;
    }
    const key = makeBibKey(data, doi, usedKeys);
    keyMap.set(doi, key);
    return makeBibEntry(data, doi, key);
  });

  return { bibText: [methodEntry, ...paperEntries].join("\n\n"), keyMap };
}

export function directedGroupLabels(link, groups, bidirectionalArrow = "↔") {
  const groupById = id => groups.find(group => group.group_id === id);
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

export function buildLinksTable(fmt, { visibleLinks, project, rawLinksById }, keyMap) {
  const links = visibleLinks || [];
  if (!links.length) return fmt === "md" ? "_No links._\n" : "\\textit{No links.}\n";

  const rows = links.map(link => {
    const { sourceLabel, targetLabel, arrow } = directedGroupLabels(link, project.groups, "↔");
    const rawIds = [...new Set([...link.a_to_b_raw_link_ids, ...link.b_to_a_raw_link_ids])];
    const dois = [...new Set(rawIds.map(id => rawLinksById.get(id)?.paper_id).filter(isDoi))];
    const manual = link.is_manual ? ["manual"] : [];
    if (fmt === "md") {
      const cites = dois.map(d => `[@${keyMap?.get(d.trim()) || d.trim()}]`);
      const src = [...cites, ...manual].join("; ") || "—";
      return `| ${escapeHtml(sourceLabel)} | ${escapeHtml(targetLabel)} | ${arrow} | ${src} |`;
    } else {
      const cites = dois.map(d => `\\citep{${keyMap?.get(d.trim()) || d.trim().replace(/[^a-zA-Z0-9_.\-]/g, "_")}}`);
      const src = [...cites, ...manual].join("; ") || "---";
      const texArrow = arrow === "↔" ? "$\\leftrightarrow$" : "$\\rightarrow$";
      return `  ${texEscape(sourceLabel)} & ${texEscape(targetLabel)} & ${texArrow} & ${src} \\\\`;
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
      "\\begin{longtable}{@{}p{0.22\\textwidth}p{0.22\\textwidth}cp{0.38\\textwidth}@{}}",
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

export function buildExcludedLinksTable(fmt, project) {
  const groupById = id => project.groups.find(group => group.group_id === id);

  const excluded = Object.values(project.link_decisions || {})
    .filter(d => d.display_status === "excluded");
  if (!excluded.length) return null;

  const rows = excluded.map(d => {
    const link = project.links.find(l => l.edge_id === d.edge_id);
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
      "\\begin{longtable}{@{}p{0.23\\textwidth}p{0.23\\textwidth}p{0.48\\textwidth}@{}}",
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
  const greekLetters = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi o pi rho sigma tau upsilon phi chi psi omega".split(" ");
  const greek = new Map([..."αβγδεζηθικλμνξοπρστυφχψω"].map((character, index) =>
    [character, `\\(${greekLetters[index] === "o" ? "o" : `\\${greekLetters[index]}`}\\)`]));
  const replacements = new Map([
    ["\\", "\\textbackslash{}"], ["{", "\\{"], ["}", "\\}"],
    ["&", "\\&"], ["%", "\\%"], ["$", "\\$"], ["#", "\\#"], ["_", "\\_"],
    ["~", "\\textasciitilde{}"], ["^", "\\textasciicircum{}"], ["/", "/\\allowbreak{}"],
    ["→", "$\\rightarrow$"], ["←", "$\\leftarrow$"], ["↔", "$\\leftrightarrow$"],
    ["–", "---"], ["—", "---"], ["…", "\\ldots{}"], ["×", "$\\times$"],
  ]);
  return [...normalizedLatexText(s)].map(character => {
    if (replacements.has(character)) return replacements.get(character);
    if (greek.has(character)) return greek.get(character);
    return character.charCodeAt(0) <= 0x7f ? character : "?";
  }).join("");
}

export function buildMarkdownFiles(input, { bibText, keyMap }, svgStr = null, graphImageBytes = null) {
  const { project, visibleLinks } = input;
  const groupById = id => project.groups.find(group => group.group_id === id);
  const hasGraph = (visibleLinks || []).length > 0;
  const ivLabel = groupById(project?.iv_group_id)?.label || "Independent variable";
  const dvLabel = groupById(project?.dv_group_id)?.label || "Dependent variable";

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
    ...(input.permalink ? [``, `[View the public causal map](<${String(input.permalink).replace(/[\r\n]/g, "")}>)`] : []),
    ``,
    `## Causal Graph`,
    ``,
    graphImageBytes ? `![Causal DAG](dag-graph.png)`
      : svgStr ? `![Causal DAG](dag.svg)`
      : hasGraph ? `*(Graph figure export is not yet available — the causal structure is listed in the Causal Links table below.)*`
        : `*(No DAG to display — create groups and add edges first.)*`,
    ``,
    `## Causal Links`,
    ``,
    buildLinksTable("md", input, keyMap),
    ...(buildExcludedLinksTable("md", project) ? [
      `## Excluded Links`,
      ``,
      `The following edges were reviewed and excluded from the working causal map.`,
      ``,
      buildExcludedLinksTable("md", project),
    ] : []),
    `# References`,
    ``,
  ].join("\n");

  const files = [{ name: "dag.md", data: md }, { name: "references.bib", data: bibText }];
  if (svgStr) files.push({ name: "dag.svg", data: svgStr });
  if (graphImageBytes) files.push({ name: "dag-graph.png", data: graphImageBytes });
  return files;
}

export function buildLatexFiles(input, { bibText, keyMap }, svgStr = null, graphImageBytes = null) {
  const { project, visibleLinks } = input;
  const groupById = id => project.groups.find(group => group.group_id === id);
  const hasGraph = (visibleLinks || []).length > 0;
  const ivLabel = groupById(project?.iv_group_id)?.label || "Independent variable";
  const dvLabel = groupById(project?.dv_group_id)?.label || "Dependent variable";

  const tex = [
    `\\documentclass{article}`,
    `\\usepackage[utf8]{inputenc}`,
    `\\usepackage{graphicx}`,
    `\\usepackage{pdflscape}`,
    `\\usepackage{geometry}`,
    `\\usepackage{booktabs}`,
    `\\usepackage{longtable}`,
    `\\usepackage{hyperref}`,
    `\\usepackage{xurl}`,
    `\\usepackage{natbib}`,
    `\\setlength{\\emergencystretch}{3em}`,
    `% To compile: pdflatex dag.tex && bibtex dag && pdflatex dag.tex && pdflatex dag.tex`,
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
    ...(input.permalink ? [``, `\\noindent Public causal map: \\url{${String(input.permalink).replace(/[\r\n]/g, "")}}`] : []),
    ``,
    graphImageBytes ? `` : `\\section{Causal Graph}`,
    ``,
    graphImageBytes
      ? `\\clearpage\n\\begin{landscape}\n\\newgeometry{margin=0.3in,landscape}\n\\thispagestyle{empty}\n\\centering\\includegraphics[width=\\textwidth,height=\\textheight,keepaspectratio]{dag-graph.png}\n\\clearpage\n\\restoregeometry\n\\end{landscape}`
      : svgStr
        ? `\\textit{The causal graph image could not be rendered; the causal structure is listed below.}`
      : ((visibleLinks || []).length
        ? `\\textit{Graph figure export is not yet available; the causal structure is listed in the Causal Links table below.}`
        : `\\textit{No DAG to display --- create groups and add edges first.}`),
    ``,
    `\\section{Causal Links}`,
    ``,
    buildLinksTable("tex", input, keyMap),
    ``,
    ...(buildExcludedLinksTable("tex", project) ? [
      `\\section{Excluded Links}`,
      ``,
      `The following edges were reviewed and excluded from the working causal map.`,
      ``,
      buildExcludedLinksTable("tex", project),
      ``,
    ] : []),
    `\\bibliographystyle{plainnat}`,
    `\\bibliography{references}`,
    ``,
    `\\end{document}`,
  ].join("\n");

  const files = [{ name: "dag.tex", data: tex }, { name: "references.bib", data: bibText }];
  if (svgStr) files.push({ name: "dag.svg", data: svgStr });
  if (graphImageBytes) files.push({ name: "dag-graph.png", data: graphImageBytes });
  return files;
}

/** @returns {SerializedProjectPayload} */
export function buildProjectPayload({ project, ...view }, savedAt) {
  const { candidate_queue: _derivedCandidateQueue, ...persistedProject } = project;
  return /** @type {SerializedProjectPayload} */ ({
    ...persistedProject,
    schema_version: PROJECT_FORMAT_VERSION,
    saved_at: savedAt,
    selectedUoa: view.selectedUoa,
    uoaFilterEnabled: view.uoaFilterEnabled,
    phase: view.phase,
    workflowMode: view.workflowMode,
    changingAnchorSide: view.changingAnchorSide,
    variableLayoutSource: view.variableLayoutSource,
    dagLayoutMode: view.dagLayoutMode,
    seeds: {
      iv: [...view.seeds.iv],
      dv: [...view.seeds.dv],
    },
    ...(Object.hasOwn(view, "definitionDraft") ? { definitionDraft: view.definitionDraft || null } : {}),
    ...(Object.hasOwn(view, "undoHistory") ? { undoHistory: view.undoHistory || [],
      undoPointer: Number.isInteger(view.undoPointer) ? view.undoPointer : -1,
      actionLog: view.actionLog || [] } : {}),
  });
}

export function buildWorkingMapPayload({ project, visibleLinks, rejectedVariables, hiddenVariableIds }, timestamp) {
  const visibleGroupIds = new Set([
    project.iv_group_id,
    project.dv_group_id,
    ...visibleLinks.flatMap((link) => [link.group_a, link.group_b]),
  ]);
  return {
    schema_version: WORKING_MAP_FORMAT_VERSION,
    exported_at: timestamp,
    iv_group_id: project.iv_group_id,
    dv_group_id: project.dv_group_id,
    groups: project.groups.filter(group => group.variable_ids?.length).filter((group) => visibleGroupIds.has(group.group_id)),
    links: visibleLinks,
    manual_edges: project.manual_edges.filter((e) => !e.deleted),
    rejected_variables: rejectedVariables,
    hidden_variable_ids: [...hiddenVariableIds],
    allows_bidirectional_links: true,
    allows_cycles: true,
  };
}
