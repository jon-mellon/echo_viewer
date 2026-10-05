export function nearbyMapNeighbors(eligibleIds, selectedIds, variableById, limit = 12) {
  const selected = new Set(selectedIds);
  const origins = [...selected].map(id => variableById.get(id))
    .filter(variable => Number.isFinite(variable?.map_x) && Number.isFinite(variable?.map_y));
  if (!origins.length) return [];
  const nearby = [];
  for (const id of eligibleIds) {
    if (selected.has(id)) continue;
    const variable = variableById.get(id);
    if (!Number.isFinite(variable?.map_x) || !Number.isFinite(variable?.map_y)) continue;
    let distance = Infinity;
    for (const origin of origins) {
      const dx = variable.map_x - origin.map_x;
      const dy = variable.map_y - origin.map_y;
      distance = Math.min(distance, dx * dx + dy * dy);
    }
    nearby.push({ variable_id: id, distance, map_distance: true });
  }
  nearby.sort((a, b) => a.distance - b.distance || a.variable_id.localeCompare(b.variable_id));
  return nearby.slice(0, limit);
}
