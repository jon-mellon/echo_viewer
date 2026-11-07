import { EvidencePanelCatalog, evidencePanelKey } from "./evidence_panel_catalog.mjs";

export const VARIABLE_MAP_BINDINGS = Object.freeze({
  "f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b": {
    root: "/variable-maps/f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b/",
    layoutSource: "qwen3-embed-pca-v1", bytes: 8703,
    sha256: "c7c3af8203e15208a92731b47c590477487772cba4a06362b3252a1afd7f51c3",
  },
});

export class VariableMapCatalog extends EvidencePanelCatalog {
  constructor(options = {}) { super({ bindings: VARIABLE_MAP_BINDINGS, ...options }); }

  async prepare(snapshot, layoutSource = "") {
    const binding = this.bindings[snapshot];
    if (!binding || (layoutSource && layoutSource !== binding.layoutSource)
      || typeof DecompressionStream !== "function") return null;
    const index = await this.cached(`${snapshot}:map-index`, () => this.read(`${binding.root}index.json.gz`, binding));
    if (index.format !== "echo-variable-map-index-v1" || index.evidence_snapshot !== snapshot
      || index.layout_source !== binding.layoutSource) throw new Error("Variable map index binding mismatch");
    return index;
  }

  async load(snapshot, ids, layoutSource = "") {
    if (!ids.length) return null;
    const index = await this.prepare(snapshot, layoutSource);
    if (!index) return null;
    const key = await evidencePanelKey(ids);
    const entry = index.entries[key];
    if (!entry) return null;
    return this.cached(`${snapshot}:map:${key}`, async () => {
      const payload = await this.read(`${this.bindings[snapshot].root}${entry.sha256}.json.gz`, entry);
      if (payload.format !== "echo-variable-map-v1" || payload.evidence_snapshot !== snapshot
        || payload.layout_source !== index.layout_source || !Array.isArray(payload.variables)
        || payload.variables.length !== new Set(ids).size
        || await evidencePanelKey(payload.variables.map(r => r.variable_id)) !== key
        || payload.variables.some(r => !Number.isFinite(r.map_x) || !Number.isFinite(r.map_y))) throw new Error("Variable map coverage mismatch");
      return payload;
    });
  }
}

export const variableMapCatalog = new VariableMapCatalog();
