export const EVIDENCE_PANEL_BINDINGS = Object.freeze({
  "f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b": {
    root: "/evidence-panels/f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b/",
    sha256: "c355029039a17a0c12511be7a254ce1fb7ecd3c9cc6f281fa40056660d32d33f",
    bytes: 215842,
  },
});

export async function evidencePanelKey(ids) {
  return digest(new TextEncoder().encode([...new Set(ids)].sort().join("\n")));
}

async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map(value => value.toString(16).padStart(2, "0")).join("");
}

export class EvidencePanelCatalog {
  constructor({ bindings = EVIDENCE_PANEL_BINDINGS, fetchImpl = (...args) => fetch(...args) } = {}) {
    this.bindings = bindings;
    this.fetchImpl = fetchImpl;
    this.pending = new Map();
  }

  async read(url, integrity) {
    const response = await this.fetchImpl(url, { cache: "force-cache", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Evidence bundle HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== integrity.bytes || await digest(bytes) !== integrity.sha256) throw new Error("Evidence bundle integrity mismatch");
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).json();
  }

  cached(key, load) {
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = load().catch(error => { this.pending.delete(key); throw error; });
    this.pending.set(key, promise);
    if (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value);
    return promise;
  }

  async load(snapshot, ids) {
    const binding = this.bindings[snapshot];
    if (!binding || !ids.length || typeof DecompressionStream !== "function") return null;
    const key = await evidencePanelKey(ids);
    const index = await this.cached(`${snapshot}:index`, () => this.read(`${binding.root}index.json.gz`, binding));
    if (index.format !== "echo-evidence-panel-index-v1" || index.evidence_snapshot !== snapshot) throw new Error("Evidence index snapshot mismatch");
    const entry = index.entries[key];
    if (!entry) return null;
    return this.cached(`${snapshot}:${key}`, async () => {
      const panel = await this.read(`${binding.root}${entry.sha256}.json.gz`, entry);
      if (panel.format !== "echo-evidence-panel-v1" || panel.evidence_snapshot !== snapshot
        || !Array.isArray(panel.links) || !Array.isArray(panel.variables)
        || panel.links.length !== new Set(ids).size
        || await evidencePanelKey(panel.links.map(r => r.raw_causal_link_id)) !== key) throw new Error("Evidence bundle coverage mismatch");
      const labels = new Set(panel.variables.map(v => v.variable_id));
      if (panel.links.some(r => !labels.has(r.source_variable_id) || !labels.has(r.target_variable_id))) throw new Error("Evidence bundle labels missing");
      return panel;
    });
  }
}

export const evidencePanelCatalog = new EvidencePanelCatalog();
