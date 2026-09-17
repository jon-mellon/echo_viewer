export const VARIABLE_SEARCH_CATALOG_URL = "/variable-search-catalog.json";

const normalize = value => String(value ?? "").trim().toLowerCase();

export class StaticVariableSearchCatalog {
  constructor() {
    this.status = "idle";
    this.records = [];
    this.error = null;
    this.loading = null;
  }

  async load(url = VARIABLE_SEARCH_CATALOG_URL, fetchImpl = globalThis.fetch) {
    if (this.status === "ready") return this;
    if (this.loading) return this.loading;
    this.status = "loading";
    this.loading = (async () => {
      try {
        const response = await fetchImpl(url, { cache: "force-cache" });
        if (!response.ok) throw new Error(`Could not load variable search catalog: HTTP ${response.status}`);
        const payload = await response.json();
        if (payload?.format !== "echo-variable-search-v1" || !Array.isArray(payload.records)) {
          throw new Error("Unsupported variable search catalog format.");
        }
        this.records = payload.records;
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
