import { EvidencePanelCatalog } from "./evidence_panel_catalog.mjs";

export const VARIABLE_NEIGHBOR_BINDINGS = Object.freeze({
  "f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b": {
    root: "/variable-neighbors/f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b/",
    bytes: 11144, sha256: "c76dddc936de08e56f67e89a646d11e9053b99f24e151cdc3ed9c59fee2be525",
  },
});
const columns = ["variable_id", "neighbor_variable_id", "neighbor_index", "display_rank", "cosine_similarity", "llm_rank", "embedding_rank", "is_substantive_duplicate"];

export class VariableNeighborCatalog extends EvidencePanelCatalog {
  constructor(options = {}) { super({ bindings: VARIABLE_NEIGHBOR_BINDINGS, ...options }); }

  async prepare(snapshot) {
    const binding = this.bindings[snapshot];
    if (!binding || typeof DecompressionStream !== "function") return null;
    const index = await this.cached(`${snapshot}:neighbor-index`, () => this.read(`${binding.root}index.json.gz`, binding));
    if (index.format !== "echo-variable-neighbor-index-v1" || index.evidence_snapshot !== snapshot) throw new Error("Neighbor index binding mismatch");
    return index;
  }

  async load(snapshot, requestedIds) {
    const ids = [...new Set(requestedIds)];
    if (!ids.length || ids.length > 40 || ids.some(id => !/^v[a-f0-9]{16}$/.test(id))) return null;
    const index = await this.prepare(snapshot);
    if (!index) return null;
    const buckets = [...new Set(ids.map(id => id.slice(1, 3)))];
    const payloads = await Promise.all(buckets.map(bucket => this.cached(`${snapshot}:neighbors:${bucket}`, async () => {
      const entry = index.entries[bucket];
      if (!entry) throw new Error("Missing neighbor bucket");
      const payload = await this.read(`${this.bindings[snapshot].root}${entry.sha256}.json.gz`, entry);
      if (payload.format !== "echo-variable-neighbors-v1" || payload.evidence_snapshot !== snapshot
        || JSON.stringify(payload.columns) !== JSON.stringify(columns)
        || !Array.isArray(payload.variable_ids) || !Array.isArray(payload.rows)) throw new Error("Neighbor payload binding mismatch");
      const covered = new Set(payload.variable_ids), byId = new Map();
      if ([...covered].some(id => id.slice(1, 3) !== bucket)) throw new Error("Neighbor bucket mismatch");
      for (const values of payload.rows) {
        if (values.length !== columns.length || !covered.has(values[0])) throw new Error("Neighbor coverage mismatch");
        if (!byId.has(values[0])) byId.set(values[0], []);
        byId.get(values[0]).push(values);
      }
      return { covered, byId };
    })));
    const byBucket = new Map(buckets.map((bucket, i) => [bucket, payloads[i]]));
    if (ids.some(id => !byBucket.get(id.slice(1, 3)).covered.has(id))) return null;
    return ids.flatMap(id => byBucket.get(id.slice(1, 3)).byId.get(id) || [])
      .sort((a, b) => a[0].localeCompare(b[0]) || a[3] - b[3])
      .map(values => Object.fromEntries(columns.map((column, i) => [column, values[i]])));
  }
}

export const variableNeighborCatalog = new VariableNeighborCatalog();
