import { EvidencePanelCatalog } from "./evidence_panel_catalog.mjs";

export const VARIABLE_INCIDENT_BINDINGS = Object.freeze({
  "f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b": {
    root: "/variable-incidents/f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b/",
    bytes: 11207, sha256: "dc96a967d8212c8408048cb3cb29f61094ef868aa4265f8f3c963f9e88b7192b",
  },
});
const columns = ["raw_causal_link_id", "source_variable_id", "target_variable_id", "paper_id", "paper_title", "within_table_occurrence_id", "causal_link_existence", "identification_strategy", "target_population", "_row_order"];

export class VariableIncidentCatalog extends EvidencePanelCatalog {
  constructor(options = {}) { super({ bindings: VARIABLE_INCIDENT_BINDINGS, ...options }); }

  async prepare(snapshot) {
    const binding = this.bindings[snapshot];
    if (!binding || typeof DecompressionStream !== "function") return null;
    const index = await this.cached(`${snapshot}:incident-index`, () => this.read(`${binding.root}index.json.gz`, binding));
    if (index.format !== "echo-variable-incident-index-v1" || index.evidence_snapshot !== snapshot) throw new Error("Incident index binding mismatch");
    return index;
  }

  async load(snapshot, requestedIds) {
    const ids = [...new Set(requestedIds)];
    if (!ids.length || ids.length > 40 || ids.some(id => !/^v[a-f0-9]{16}$/.test(id))) return null;
    const index = await this.prepare(snapshot);
    if (!index) return null;
    const wanted = new Set(ids), buckets = [...new Set(ids.map(id => id.slice(1, 3)))];
    const payloads = await Promise.all(buckets.map(bucket => this.cached(`${snapshot}:incidents:${bucket}`, async () => {
      const entry = index.entries[bucket];
      if (!entry) throw new Error("Missing incident bucket");
      const payload = await this.read(`${this.bindings[snapshot].root}${entry.sha256}.json.gz`, entry);
      if (payload.format !== "echo-variable-incidents-v1" || payload.evidence_snapshot !== snapshot
        || JSON.stringify(payload.columns) !== JSON.stringify(columns)
        || !Array.isArray(payload.variable_ids) || !Array.isArray(payload.rows)) throw new Error("Incident payload binding mismatch");
      const covered = new Set(payload.variable_ids);
      if ([...covered].some(id => id.slice(1, 3) !== bucket)
        || payload.rows.some(row => row.length !== columns.length || (!covered.has(row[1]) && !covered.has(row[2])))) throw new Error("Incident coverage mismatch");
      return { covered, rows: payload.rows };
    })));
    const byBucket = new Map(buckets.map((bucket, i) => [bucket, payloads[i]]));
    if (ids.some(id => !byBucket.get(id.slice(1, 3)).covered.has(id))) return null;
    const unique = new Map();
    for (const payload of payloads) for (const row of payload.rows) {
      if (wanted.has(row[1]) || wanted.has(row[2])) unique.set(row[0], row);
    }
    return [...unique.values()].sort((a, b) => a[9] - b[9])
      .map(values => Object.fromEntries(columns.slice(0, -1).map((column, i) => [column, values[i]])));
  }
}

export const variableIncidentCatalog = new VariableIncidentCatalog();
