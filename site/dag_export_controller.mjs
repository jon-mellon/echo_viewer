import * as exportData from "./dag_exports.mjs";
import { makeZip } from "./dag_export_zip.mjs";
import { setSafeUrl } from "./dom_builder.mjs";

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
  const crossRefPending = new Map();
  let crossRefQueue = Promise.resolve();
  let nextCrossRefStart = 0;
  const CROSSREF_INTERVAL_MS = 210; // Public pool: at most five requests per second.

  function captureInput() {
    return structuredClone({
      project: state.project, visibleLinks: state.visibleLinks,
      rawLinksById: state.rawLinksById, cacheCompatibility: state.data.cache_compatibility,
      rejectedVariables: rejectedVariableEntries(), hiddenVariableIds: [...rejectedVariableIdSet()],
      canonicalByVariableId: [...state.clusterOf.entries()],
    });
  }

  async function fetchCrossRefNow(doi, attempt = 0) {
    if (crossRefCache.has(doi)) return crossRefCache.get(doi);
    try {
      const delay = Math.max(0, nextCrossRefStart - Date.now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      nextCrossRefStart = Date.now() + CROSSREF_INTERVAL_MS;
      const response = await fetchImpl(
        `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (response.status === 429 && attempt < 4) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const retryDelay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000;
        nextCrossRefStart = Math.max(nextCrossRefStart, Date.now() + retryDelay);
        return fetchCrossRefNow(doi, attempt + 1);
      }
      if (response.ok) return (await response.json()).message;
    } catch {
      // DOI-only fallback entries keep exports usable when Crossref is unavailable.
    }
    return null;
  }

  function fetchCrossRef(doi) {
    if (crossRefCache.has(doi)) return Promise.resolve(crossRefCache.get(doi));
    if (crossRefPending.has(doi)) return crossRefPending.get(doi);
    const pending = crossRefQueue
      .then(() => fetchCrossRefNow(doi))
      .then((data) => {
        crossRefCache.set(doi, data);
        crossRefPending.delete(doi);
        return data;
      });
    crossRefPending.set(doi, pending);
    crossRefQueue = pending.catch(() => null);
    return pending;
  }

  function requestedDois(input) {
    const dois = exportData.collectAllDagDois(input);
    return { dois, requested: [...new Set([exportData.METHOD_DOI, ...dois])] };
  }

  function warmBibliography(input = captureInput()) {
    const { requested } = requestedDois(input);
    for (const doi of requested) void fetchCrossRef(doi);
  }

  async function fetchBibliography(input, onProgress = () => {}) {
    const { dois, requested } = requestedDois(input);
    let completed = 0;
    const entries = await Promise.all(requested.map(async (doi) => {
      const data = await fetchCrossRef(doi);
      completed += 1;
      onProgress(completed, requested.length);
      return [doi, data];
    }));
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

  function setEnrichmentProgress(completed, total) {
    const message = completed
      ? `Enriching references… ${completed}/${total}`
      : `Waiting for reference enrichment… 0/${total}`;
    [elements.exportBib, elements.exportMd, elements.exportTex].forEach(button => {
      button.textContent = message;
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    setSafeUrl(anchor, "href", url);
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
      const total = requestedDois(input).requested.length;
      setEnrichmentProgress(0, total);
      const { bibText } = await fetchBibliography(input, setEnrichmentProgress);
      downloadBlob(new Blob([bibText], { type: "text/plain" }), "references.bib");
    } finally {
      setBusy(false);
    }
  }

  async function exportDocument(format) {
    const input = captureInput();
    setBusy(true);
    try {
      const total = requestedDois(input).requested.length;
      setEnrichmentProgress(0, total);
      const bibliography = await fetchBibliography(input, setEnrichmentProgress);
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
    downloadBlob,
    downloadJson,
    warmBibliography,
  };
}
