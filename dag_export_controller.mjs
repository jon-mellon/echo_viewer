import * as exportData from "./dag_exports.mjs";
import { makeZip } from "./dag_export_zip.mjs";

// Browser-side export orchestration. Pure serialization stays in dag_exports;
// this controller owns metadata I/O, snapshots, busy state, and downloads.
export function createDagExportController({
  state, elements, rejectedVariableEntries, rejectedVariableIdSet,
  projectPayload, aggregateGroupLinks, computeVisibleLinks, nowIso,
  getDagSvgString = () => null,
  fetchImpl = (...args) => fetch(...args),
  alertImpl = message => window.alert(message),
}) {
  const crossRefCache = new Map();

  function captureInput() {
    return structuredClone({
      project: state.project, visibleLinks: state.visibleLinks,
      rawLinksById: state.rawLinksById, cacheCompatibility: state.data.cache_compatibility,
      rejectedVariables: rejectedVariableEntries(), hiddenVariableIds: [...rejectedVariableIdSet()],
      canonicalByVariableId: [...state.clusterOf.entries()],
    });
  }

  async function fetchCrossRef(doi) {
    if (crossRefCache.has(doi)) return crossRefCache.get(doi);
    try {
      const response = await fetchImpl(
        `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (!response.ok) return null;
      const data = (await response.json()).message;
      crossRefCache.set(doi, data);
      return data;
    } catch {
      return null;
    }
  }

  async function fetchBibliography(input) {
    const dois = exportData.collectAllDagDois(input);
    const requested = [...new Set([exportData.METHOD_DOI, ...dois])];
    const entries = await Promise.all(requested.map(async doi => [doi, await fetchCrossRef(doi)]));
    return exportData.buildBibText(dois, new Map(entries));
  }

  function setBusy(busy) {
    [elements.exportBib, elements.exportMd, elements.exportTex].forEach(button => {
      if (busy) {
        button._origText = button.textContent;
        button.textContent = "Working…";
        button.disabled = true;
      } else {
        button.textContent = button._origText || button.textContent;
        button.disabled = false;
      }
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function downloadJson(payload, filename) {
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), filename);
  }

  async function exportBib() {
    const input = captureInput();
    if (!exportData.collectAllDagDois(input).length && !input.visibleLinks?.length) {
      alertImpl("No links in the DAG yet.");
      return;
    }
    setBusy(true);
    try {
      const { bibText } = await fetchBibliography(input);
      downloadBlob(new Blob([bibText], { type: "text/plain" }), "references.bib");
    } finally {
      setBusy(false);
    }
  }

  async function exportDocument(format) {
    const input = captureInput();
    setBusy(true);
    try {
      const bibliography = await fetchBibliography(input);
      const files = format === "md"
        ? exportData.buildMarkdownFiles(input, bibliography, getDagSvgString())
        : exportData.buildLatexFiles(input, bibliography, getDagSvgString());
      downloadBlob(new Blob([makeZip(files)], { type: "application/zip" }),
        format === "md" ? "causal_map.zip" : "causal_map_latex.zip");
    } finally {
      setBusy(false);
    }
  }

  function exportProject() {
    aggregateGroupLinks();
    downloadJson({ ...projectPayload(), exported_at: nowIso() }, "dag_project.json");
  }

  function exportWorkingMap() {
    aggregateGroupLinks();
    computeVisibleLinks();
    downloadJson(exportData.buildWorkingMapPayload(captureInput(), nowIso()), "working_causal_map.json");
  }

  return {
    captureInput,
    exportBib,
    exportMd: () => exportDocument("md"),
    exportTex: () => exportDocument("tex"),
    exportProject,
    exportWorkingMap,
    downloadJson,
  };
}
