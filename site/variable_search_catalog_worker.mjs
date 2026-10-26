// Parse large catalogs off the UI thread; send small batches with backpressure
// so structured cloning cannot turn into another long main-thread task.
import { readSearchCatalogPayload } from "./variable_search_catalog.mjs";
let records = null;
let offset = 0;
function next() {
  if (offset >= records.length) {
    records = null;
    self.postMessage({ type: "done" });
    return;
  }
  const batch = records.slice(offset, offset + 2000);
  offset += batch.length;
  self.postMessage({ type: "records", records: batch });
}
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "next") { next(); return; }
    if (data.type !== "load") return;
    const payload = await readSearchCatalogPayload(data.url);
    if (payload.format !== "echo-variable-search-v1" || !Array.isArray(payload.records)) {
      throw new Error("Unsupported variable search catalog format.");
    }
    if (payload.evidence_snapshot !== data.snapshotId) throw new Error("Search catalog evidence snapshot mismatch.");
    records = payload.records;
    offset = 0;
    self.postMessage({ type: "header", payload: { format: payload.format, evidence_snapshot: payload.evidence_snapshot } });
    next();
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || String(error) });
  }
};
