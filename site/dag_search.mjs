// Search decisions only; callers supply visibility and unit-of-analysis policy.
const normalized = value => String(value ?? "").trim().toLowerCase();

export function anchorGroupSearchMatch(group, query, index, variableById, searchRecordById = null) {
  const labelMatches = !query || normalized(group.label || group.group_id).includes(query);
  let variableMatch = "";
  if (query && !labelMatches) {
    for (const variableId of group.variable_ids || []) {
      const variable = variableById.get(variableId) || searchRecordById?.get(variableId);
      if (!variable) continue;
      const fields = [
        variable.display_label,
        variable.concept_label,
        variable.raw_variable_text,
        variable.variable_id,
      ].filter(Boolean);
      const matchedField = fields.find((field) => normalized(field).includes(query));
      if (!matchedField) continue;
      variableMatch = matchedField;
      break;
    }
  }
  return {
    group,
    index,
    labelMatches,
    variableMatch,
    matches: labelMatches || Boolean(variableMatch),
  };
}

export function availableSetupAnchorGroups(project, side) {
  if (side === "instrument") return (project?.groups || [])
    .filter(group => group.variable_ids?.length)
    .filter(group => group.group_id !== project.iv_group_id && group.group_id !== project.dv_group_id);
  const currentId = side === "dv" ? project.dv_group_id : project.iv_group_id;
  const oppositeId = side === "dv" ? project.iv_group_id : project.dv_group_id;
  return (project?.groups || [])
    .filter((group) => group.variable_ids?.length)
    .filter((group) => group.group_id !== oppositeId)
    .filter((group) => group.group_id === currentId || !["iv", "dv"].includes(group.type));
}

export function searchVariables(query, { variables, selectedUoa, uoaFilterEnabled, uoaMatches }, limit = 20) {
  const terms = normalized(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const pool = (uoaFilterEnabled && selectedUoa)
    ? variables.filter(v => uoaMatches(v.uoa, selectedUoa))
    : variables;
  return pool
    .map((v) => {
      const haystack = normalized([v.variable_id, v.display_label, v.concept_label, v.raw_variable_text, v.paper_id, v.uoa].join(" "));
      if (!terms.every((t) => haystack.includes(t))) return null;
      let score = 0;
      const label = normalized(v.display_label || v.concept_label);
      const concept = normalized(v.concept_label);
      for (const t of terms) {
        if (label === t || concept === t) score += 20;
        else if (label.startsWith(t) || concept.startsWith(t)) score += 10;
        else score += 1;
      }
      return { variable: v, score };
    })
    .filter(Boolean)
    .sort((a, b) => (b.score - a.score) || (a.variable.index - b.variable.index))
    .slice(0, limit)
    .map((item) => item.variable);
}

export function groupNeighborSuggestions(group, {
  variableById, blockedIds, clusterMemberIds, rejectedIds = new Set(),
  selectedUoa, uoaFilterEnabled = false, uoaMatches,
}, limit) {
  const seen = new Set(group.variable_ids);
  const suggestions = [];
  for (const variableId of group.variable_ids) {
    const v = variableById.get(variableId);
    for (const neighbor of v?.similarity_neighbors || []) {
      if (seen.has(neighbor.variable_id)) continue;
      if (clusterMemberIds(neighbor.variable_id).some((id) => blockedIds.has(id) || rejectedIds.has(id))) continue;
      const candidate = variableById.get(neighbor.variable_id);
      if (!candidate) continue;
      if (uoaFilterEnabled && selectedUoa && !uoaMatches(candidate.uoa, selectedUoa)) continue;
      seen.add(neighbor.variable_id);
      suggestions.push(neighbor);
    }
  }
  return suggestions
    .sort((a, b) => (Number(a.llm_rank || 99) - Number(b.llm_rank || 99)) || (b.cosine_similarity - a.cosine_similarity))
    .slice(0, limit);
}

export function searchAnchorGroups(project, side, query, variableById, limit = 12, searchRecordById = null) {
  return availableSetupAnchorGroups(project, side)
    .map((group, index) => anchorGroupSearchMatch(group, normalized(query), index,
      variableById, searchRecordById))
    .filter(result => result.matches)
    .sort((a, b) => Number(b.labelMatches) - Number(a.labelMatches) || a.index - b.index)
    .slice(0, limit);
}

// Group-first search can stop at the first matching member, instead of
// collecting every matching variable in the evidence catalog. Role/label
// changes retain these caches; membership replacement or append invalidates.
export class AnchorGroupSearchIndex {
  constructor() { this.groups = []; this.queries = new Map(); this.catalog = null; }
  entry(group, catalog, old) {
    const ids = group.variable_ids || [];
    if (old?.ids === group.variable_ids && old.length === ids.length) return old;
    return { id: group.group_id, ids: group.variable_ids, length: ids.length,
      fields: ids.map(id => catalog?.fieldsById.get(id)),
      // This coarse native check may include paper/UOA or cross-field hits;
      // every positive candidate is verified against the original fields.
      haystack: ids.map(id => catalog?.recordById.get(id)?.[6] || "").join("\0") };
  }
  unchanged(groups, catalog) {
    return this.catalog === catalog && groups.length === this.groups.length && groups.every((g, i) => {
      const prior = this.groups[i];
      return g.group_id === prior.id && g.variable_ids === prior.ids
        && (g.variable_ids?.length || 0) === prior.length;
    });
  }
  commit(groups, catalog) {
    this.catalog = catalog;
    this.groups = groups;
    this.groupById = new Map(groups.map(group => [group.id, group]));
    this.queries.clear();
  }
  update(groups, catalog) {
    if (this.unchanged(groups, catalog)) return;
    const previous = this.catalog === catalog ? this.groupById : null;
    this.commit(groups.map(group => this.entry(group, catalog, previous?.get(group.group_id))), catalog);
  }
  async prepare(groups, catalog) {
    if (this.unchanged(groups, catalog)) return;
    const previous = this.catalog === catalog ? this.groupById : null;
    const prepared = [];
    let sliceStart = performance.now();
    for (const group of groups) {
      const ids = group.variable_ids || [];
      const old = previous?.get(group.group_id);
      if (old?.ids === group.variable_ids && old.length === ids.length) {
        prepared.push(old);
        continue;
      }
      const fields = [], chunks = [];
      // One category can contain most of the dataset. Yield inside categories,
      // rather than only between them, so search preparation cannot freeze input.
      for (let start = 0; start < ids.length; start += 1000) {
        const batch = ids.slice(start, start + 1000);
        catalog.assertCoverage(batch);
        for (const id of batch) fields.push(catalog.fieldsById.get(id));
        chunks.push(batch.map(id => catalog.recordById.get(id)?.[6] || "").join("\0"));
        if (performance.now() - sliceStart >= 8) {
          if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
          else await new Promise(resolve => setTimeout(resolve, 0));
          sliceStart = performance.now();
        }
      }
      prepared.push({ id: group.group_id, ids: group.variable_ids, length: ids.length,
        fields, haystack: chunks.join("\0") });
      if (performance.now() - sliceStart >= 8) {
        if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
        else await new Promise(resolve => setTimeout(resolve, 0));
        sliceStart = performance.now();
      }
    }
    this.commit(prepared, catalog);
  }
  search(project, side, query, variableById, catalog, limit = 12) {
    query = normalized(query);
    const available = availableSetupAnchorGroups(project, side);
    if (!query) return available.slice(0, limit).map((group, index) => ({ group, index, labelMatches: true, variableMatch: "", matches: true }));
    this.update(project.groups, catalog?.status === "ready" ? catalog : null);
    // Hydrated records may be edited in place. Always inspect those live;
    // catalog-only searches can safely reuse per-group positive/negative hits.
    const cacheable = !variableById.size;
    let cached = cacheable ? this.queries.get(query) : null;
    if (cacheable && !cached) {
      if (this.queries.size >= 16) this.queries.delete(this.queries.keys().next().value);
      this.queries.set(query, cached = new Map());
    }
    const labelHits = [], memberHits = [];
    for (let index = 0; index < available.length; index++) {
      const group = available[index];
      const labelMatches = normalized(group.label || group.group_id).includes(query);
      let variableMatch = "";
      if (!labelMatches) {
        if (cached?.has(group.group_id)) variableMatch = cached.get(group.group_id);
        else {
          const prepared = this.groupById.get(group.group_id);
          const ids = group.variable_ids || [];
          const candidate = !cacheable || prepared.haystack.includes(query);
          for (let member = 0; candidate && member < ids.length; member++) {
            const hydrated = variableById.size ? variableById.get(ids[member]) : null;
            if (hydrated) {
              variableMatch = [hydrated.display_label, hydrated.concept_label, hydrated.raw_variable_text, hydrated.variable_id]
                .filter(Boolean).find(text => normalized(text).includes(query)) || "";
            } else {
              const fields = prepared.fields[member];
              if (fields) for (let i = 0; i < fields.length; i++) {
                if (fields[i][1].includes(query)) { variableMatch = fields[i][0]; break; }
              }
            }
            if (variableMatch) break;
          }
          cached?.set(group.group_id, variableMatch);
        }
      }
      if (labelMatches || variableMatch) {
        (labelMatches ? labelHits : memberHits).push({ group, index, labelMatches, variableMatch, matches: true });
      }
    }
    return labelHits.concat(memberHits).slice(0, limit);
  }
}
