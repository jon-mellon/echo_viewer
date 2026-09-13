// Cluster identity and rejection policy shared by schema loading and the viewer.
const clean = value => String(value ?? "").trim();
export function buildDuplicateClusters(input) {
  const variables = input.map(variable => ({ ...variable }));
  const clusterOf = new Map();       // variable_id -> representative id
  const clusterMembers = new Map();  // representative id -> [variable_id, ...]
  const byCanonical = new Map();
  for (const v of variables) {
    const key = clean(v.canonical_variable_id)
      || `${v.map_x.toFixed(2)},${v.map_y.toFixed(2)}`;
    if (!byCanonical.has(key)) byCanonical.set(key, []);
    byCanonical.get(key).push(v);
  }
  for (const [canonicalId, members] of byCanonical.entries()) {
    const canonical = members.find((member) => member.variable_id === canonicalId) || members[0];
    const rep = canonical.variable_id;
    const ids = members.map((m) => m.variable_id);
    const exactStrings = new Map();
    for (const member of members) {
      const label = clean(member.display_label || member.concept_label || member.variable_id);
      if (!exactStrings.has(label)) {
        exactStrings.set(label, {
          label,
          count: 0,
          firstIndex: member.index,
          displayVariableId: member.variable_id,
        });
      }
      exactStrings.get(label).count += 1;
    }
    canonical.cluster_exact_strings = [...exactStrings.values()].sort(
      (a, b) => b.count - a.count || a.firstIndex - b.firstIndex || a.label.localeCompare(b.label)
    );
    canonical.cluster_display_variable_id = canonical.cluster_exact_strings[0]?.displayVariableId || rep;
    clusterMembers.set(rep, ids);
    for (const v of members) {
      clusterOf.set(v.variable_id, rep);
      v.cluster_id = rep;
      v.is_cluster_rep = v.variable_id === rep;
      v.cluster_size = ids.length;
    }
  }
  return { variables, clusterOf, clusterMembers };
}
export function representative(id, clusterOf = new Map()) {
  return clusterOf.get(id) || id;
}

export function members(id, clusterOf, clusterMembers) {
  return clusterMembers.get(representative(id, clusterOf)) || [id];
}

export function rejectedIds(entries, clusterOf, clusterMembers) {
  const ids = new Set();
  for (const entry of entries || []) {
    for (const id of [entry.variable_id, ...(entry.member_variable_ids || [])].filter(Boolean)) {
      for (const member of members(id, clusterOf, clusterMembers)) ids.add(member);
    }
  }
  return ids;
}

export function visibleVariables(variables, entries, clusterOf, clusterMembers) {
  const rejected = rejectedIds(entries, clusterOf, clusterMembers);
  return variables.filter(variable => !rejected.has(variable.variable_id));
}

export function mergeRejections(existing, incoming, clusterOf = new Map(), clusterMembers = new Map()) {
  const merged = new Map();
  for (const entry of [...(existing || []), ...(incoming || [])]) {
    if (!entry?.variable_id) continue;
    const id = representative(entry.variable_id, clusterOf);
    merged.set(id, { ...entry, variable_id: id,
      member_variable_ids: [...rejectedIds([entry], clusterOf, clusterMembers)] });
  }
  return [...merged.values()];
}

export function schemaRejections(project, schema, clusterOf, clusterMembers) {
  const restored = new Set((project.restored_variable_ids || []).map(id => representative(id, clusterOf)));
  const entries = mergeRejections(schema.rejected_variables, project.rejected_variables, clusterOf, clusterMembers);
  return entries.filter(entry => ![entry.variable_id, ...entry.member_variable_ids]
    .some(id => restored.has(representative(id, clusterOf))));
}

export function restoreRejection(project, variableId, clusterOf, clusterMembers) {
  const rep = representative(variableId, clusterOf);
  const matching = (project.rejected_variables || []).filter(entry =>
    rejectedIds([entry], clusterOf, clusterMembers).has(rep));
  const restored = rejectedIds(matching, clusterOf, clusterMembers);
  for (const id of members(variableId, clusterOf, clusterMembers)) restored.add(id);
  return { ...project,
    rejected_variables: (project.rejected_variables || []).filter(entry => !matching.includes(entry)),
    restored_variable_ids: [...new Set([...(project.restored_variable_ids || []), ...restored])],
  };
}

export function rejectVariables(project, entries, clusterOf, clusterMembers) {
  const rejected = rejectedIds(entries, clusterOf, clusterMembers);
  return { ...project,
    rejected_variables: mergeRejections(project.rejected_variables, entries, clusterOf, clusterMembers),
    restored_variable_ids: (project.restored_variable_ids || []).filter(id =>
      !members(id, clusterOf, clusterMembers).some(member => rejected.has(member))),
  };
}
