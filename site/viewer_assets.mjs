// Precomputed files the viewer reads in place of querying an evidence snapshot in the browser.
//
// Querying a snapshot needs DuckDB WebAssembly (a 34 MB download plus extensions and large Parquet files), which on a
// phone takes minutes. For the common questions the data pipeline publishes small files beside each snapshot, listed by
// one sidecar manifest:
//   <layout dir>/viewer-assets/manifest.json
// This module finds that manifest and binds what it lists into the catalogs. A snapshot that has none still works, from
// the committed bindings if there are any and otherwise by querying it, which is slow; that case is reported loudly
// because a snapshot made the default without these files once made opening a saved variable take minutes.
export const VIEWER_ASSETS_FORMAT = "echo-viewer-assets-v1";
const SHA256 = /^[0-9a-f]{64}$/;

export function viewerAssetsManifestUrl(layoutManifestUrl) {
  return new URL("viewer-assets/manifest.json", new URL(layoutManifestUrl, globalThis.location?.href || "http://localhost/")).href;
}

const validIndex = index => Number.isSafeInteger(index?.bytes) && index.bytes > 0 && SHA256.test(index?.sha256 || "");

/** Read and check the sidecar manifest. Returns null when the snapshot has none (or it is unusable). */
export async function fetchViewerAssets(layoutManifestUrl, snapshot, { fetchImpl = globalThis.fetch } = {}) {
  const url = viewerAssetsManifestUrl(layoutManifestUrl);
  let manifest;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
    if (response.status === 404 || response.status === 403) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    manifest = await response.json();
  } catch (error) {
    console.warn(`Viewer assets manifest unavailable (${url}); falling back.`, error);
    return null;
  }
  if (manifest?.format !== VIEWER_ASSETS_FORMAT || manifest.evidence_snapshot !== snapshot || typeof manifest.assets !== "object") {
    console.warn("Viewer assets manifest does not describe this snapshot; ignoring it.");
    return null;
  }
  const base = new URL(".", url).href;
  const assets = {};
  const catalog = manifest.assets.search_catalog;
  if (typeof catalog?.path === "string" && validIndex(catalog)) assets.searchCatalog = new URL(catalog.path, base).href;
  for (const [name, key] of [["variable_maps", "variableMaps"], ["variable_neighbors", "variableNeighbors"],
    ["variable_incidents", "variableIncidents"], ["evidence_panels", "evidencePanels"]]) {
    const asset = manifest.assets[name];
    if (typeof asset?.root !== "string" || !validIndex(asset.index)) continue;
    assets[key] = { root: new URL(asset.root, base).href, bytes: asset.index.bytes, sha256: asset.index.sha256,
      ...(typeof asset.layout_source === "string" ? { layoutSource: asset.layout_source } : {}) };
  }
  return { url, assets };
}

/** Bind the published assets into the catalogs, replacing any committed binding for the same snapshot. */
export function bindViewerAssets(snapshot, found, catalogs) {
  const { assets } = found;
  if (assets.searchCatalog) catalogs.searchCatalogs.bind(snapshot, assets.searchCatalog);
  if (assets.variableMaps) catalogs.variableMaps.bind(snapshot, assets.variableMaps);
  if (assets.variableNeighbors) catalogs.variableNeighbors.bind(snapshot, assets.variableNeighbors);
  if (assets.variableIncidents) catalogs.variableIncidents.bind(snapshot, assets.variableIncidents);
  if (assets.evidencePanels) catalogs.evidencePanels.bind(snapshot, assets.evidencePanels);
  return Object.keys(assets);
}

/** Which of the assets the viewer relies on are still unavailable for a snapshot, after binding. */
export function missingViewerAssets(snapshot, catalogs) {
  return [["search catalog", catalogs.searchCatalogs.has(snapshot)], ["variable maps", Boolean(catalogs.variableMaps.bindings[snapshot])]]
    .filter(([, present]) => !present).map(([name]) => name);
}
