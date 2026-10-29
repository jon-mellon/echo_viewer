export const VARIABLE_SEARCH_CATALOG_URL = "/variable-search-catalog.json.gz";

// Immutable catalog bindings. Unknown snapshots use their own evidence adapter.
export const SNAPSHOT_SEARCH_CATALOGS = Object.freeze({
  "99a8fd29ae81a1852ed181a62df01b989b99b536848bbf59f65a0ce8ea6871c0": "/search-catalogs/99a8fd29ae81a1852ed181a62df01b989b99b536848bbf59f65a0ce8ea6871c0.json.gz",
  "f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b": "/search-catalogs/f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b.json.gz",
});

export function variableSearchPayload(variables, snapshotId) {
  return { format: "echo-variable-search-v1", evidence_snapshot: snapshotId,
    records: variables.map(v => [v.variable_id, v.display_label || "", v.concept_label || "",
      v.raw_variable_text || "", v.paper_id || "", v.uoa || "",
      normalize([v.variable_id, v.display_label, v.concept_label, v.raw_variable_text, v.paper_id, v.uoa].join(" ")),
      normalize(v.display_label || v.concept_label), normalize(v.concept_label), Number(v.index)]) };
}

async function variableSearchPayloadInBatches(variables, snapshotId) {
  const records = [];
  for (let start = 0; start < variables.length; start += 1000) {
    records.push(...variableSearchPayload(variables.slice(start, start + 1000), snapshotId).records);
    if (start + 1000 < variables.length) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { format: "echo-variable-search-v1", evidence_snapshot: snapshotId, records };
}

const normalize = value => String(value ?? "").trim().toLowerCase();

export async function readSearchCatalogPayload(url, fetchImpl = globalThis.fetch) {
  const compressed = url.endsWith(".gz") && typeof DecompressionStream === "function";
  const response = await fetchImpl(compressed ? url : url.replace(/\.gz$/, ""), { cache: "force-cache" });
  if (!response.ok) throw new Error(`Could not load variable search catalog: HTTP ${response.status}`);
  return compressed
    ? new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).json()
    : response.json();
}

function loadCatalogInWorker(url, snapshotId, onRecords) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./variable_search_catalog_worker.mjs", import.meta.url), { type: "module" });
    let payload;
    const fail = error => { worker.terminate(); reject(error); };
    worker.onerror = event => fail(new Error(event.message || "Could not load search catalog worker."));
    worker.onmessage = ({ data }) => {
      if (data.type === "error") { fail(new Error(data.message)); return; }
      if (data.type === "header") payload = { ...data.payload, records: [] };
      if (data.type === "records") {
        payload.records.push(...data.records);
        onRecords(data.records);
        worker.postMessage({ type: "next" });
      }
      if (data.type === "done") { worker.terminate(); resolve(payload); }
    };
    worker.postMessage({ type: "load", url: new URL(url, globalThis.location.href).href, snapshotId });
  });
}

export class StaticVariableSearchCatalog {
  constructor() {
    this.status = "idle";
    this.records = [];
    this.error = null;
    this.loading = null;
    this.snapshotId = null;
  }

  async loadSnapshot(snapshotId, { fetchImpl = globalThis.fetch, loadRecords } = {}) {
    if (!snapshotId) throw new Error("Search requires an evidence snapshot.");
    if ((this.status === "ready" || this.snapshotId) && this.snapshotId !== snapshotId) {
      throw new Error("A search catalog cannot be reused across evidence snapshots.");
    }
    this.snapshotId = snapshotId;
    const url = SNAPSHOT_SEARCH_CATALOGS[snapshotId];
    const staticAvailable = url && typeof DecompressionStream === "function";
    const loadPayload = staticAvailable
      ? (typeof Worker === "function" && fetchImpl === globalThis.fetch ? onRecords => loadCatalogInWorker(url, snapshotId, onRecords) : null)
      : async () => variableSearchPayloadInBatches(await loadRecords(), snapshotId);
    return this.load(staticAvailable ? url : "", fetchImpl, loadPayload);
  }

  async load(url = VARIABLE_SEARCH_CATALOG_URL, fetchImpl = globalThis.fetch, loadPayload = null) {
    if (this.status === "ready") return this;
    if (this.loading) return this.loading;
    this.status = "loading";
    this.loading = (async () => {
      try {
        this.recordById = new Map();
        this.fieldsById = new Map();
        let indexedRecords = 0;
        const indexRecords = rows => {
          for (const row of rows) {
            this.recordById.set(row[0], row);
            this.fieldsById.set(row[0], [row[1], row[2], row[3], row[0]].filter(Boolean).map(text => [text, normalize(text)]));
          }
          indexedRecords += rows.length;
        };
        // Worker batches are already separate tasks with backpressure. Build
        // their indexes as they arrive, instead of yielding through all records
        // a second time after the last batch has arrived.
        const payload = loadPayload ? await loadPayload(indexRecords) : await readSearchCatalogPayload(url, fetchImpl);
        if (payload?.evidence_snapshot && this.snapshotId && payload.evidence_snapshot !== this.snapshotId) {
          throw new Error("Search catalog evidence snapshot mismatch.");
        }
        if (payload?.format !== "echo-variable-search-v1" || !Array.isArray(payload.records)) {
          throw new Error("Unsupported variable search catalog format.");
        }
        this.snapshotId ||= payload.evidence_snapshot || null;
        this.records = payload.records;
        if (!indexedRecords) for (let start = 0; start < this.records.length; start += 2000) {
          indexRecords(this.records.slice(start, start + 2000));
          if (start + 2000 < this.records.length) await new Promise(resolve => setTimeout(resolve, 0));
        }
        this.status = "ready";
        this.error = null;
        return this;
      } catch (error) {
        this.status = "error";
        this.error = error;
        throw error;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  assertCoverage(variableIds) {
    for (const id of variableIds) if (!this.recordById?.has(id)) {
      throw new Error(`Search catalog does not cover schema member ${id}.`);
    }
  }

  conceptLabels(variableIds, snapshotId) {
    if (this.status !== "ready" || this.snapshotId !== snapshotId) return null;
    return [...new Set(variableIds)].map(id => this.recordById.get(id)).filter(Boolean)
      .sort((a, b) => a[9] - b[9])
      .map(row => ({ variable_id: row[0], concept_label: row[2], display_label: row[1] }));
  }

  searchVariables(query, limit = 20, { selectedUoa = null, uoaFilterEnabled = false,
    uoaMatches = (a, b) => a === b, allowedIds = null } = {}) {
    if (this.status !== "ready") return [];
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    if (!terms.length || limit <= 0) return [];
    const matches = [];
    for (const row of this.records) {
      const [variableId, displayLabel, conceptLabel, rawVariableText, paperId, uoa,
        searchText, labelNorm, conceptNorm, index] = row;
      if (allowedIds && !allowedIds.has(variableId)) continue;
      if (uoaFilterEnabled && selectedUoa && !uoaMatches(uoa, selectedUoa)) continue;
      if (!terms.every(term => searchText.includes(term))) continue;
      let score = 0;
      for (const term of terms) {
        if (labelNorm === term || conceptNorm === term) score += 20;
        else if (labelNorm.startsWith(term) || conceptNorm.startsWith(term)) score += 10;
        else score += 1;
      }
      matches.push({ record: { variable_id: variableId, display_label: displayLabel,
        concept_label: conceptLabel, raw_variable_text: rawVariableText,
        paper_id: paperId, uoa, index, search_record: true }, score });
    }
    matches.sort((a, b) => (b.score - a.score) || (a.record.index - b.record.index));
    return matches.slice(0, limit).map(match => match.record);
  }
}

export async function hydrateSearchResult(variableId, hydrateVariableDetails, variableById) {
  if (!variableById.has(variableId)) await hydrateVariableDetails([variableId]);
  return variableById.get(variableId) || null;
}

export const variableSearchCatalog = new StaticVariableSearchCatalog();
