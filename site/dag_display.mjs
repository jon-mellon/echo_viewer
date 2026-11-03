import { confounderPathNodeRole } from "./dag_graph.mjs";
import { wrapDagLabel } from "./dag_layout.mjs";
import { directedGroupLabels } from "./dag_exports.mjs";
import { escapeHtml } from "./text_utils.mjs";

// Display records only: no renderer, DOM or viewer-state access.
export function visNodeData(group, layoutPoint, layoutParams = {}, view) {
  const isIv = group.type === "iv";
  const isDv = group.type === "dv";
  const isInstrument = group.group_id === view.instrumentId;
  const isViolation = view.showExclusionViolations && view.exclusionViolationIds?.has(group.group_id);
  const isExogeneityCandidate = view.showExogeneity && view.exogeneityGroupIds?.has(group.group_id);
  const diagnosticCandidateIds = view.showExogeneity ? view.exogeneityGroupIds : view.showCollidersOnly
    ? view.colliderGroupIds
    : view.confounderGroupIds;
  const diagnosticPathIds = view.showExogeneity ? view.exogeneityPathGroupIds : view.showCollidersOnly
    ? view.colliderPathGroupIds
    : view.confounderPathGroupIds;
  const diagnosticRole = confounderPathNodeRole({
    confounderIds: diagnosticCandidateIds,
    pathIds: diagnosticPathIds,
  }, group.group_id, {
    ivId: view.showExogeneity ? view.instrumentId : view.ivId,
    dvId: view.dvId,
  });
  const isConfounder = view.showConfoundersOnly
    && diagnosticRole === "confounder"
    && !isIv
    && !isDv;
  const isCollider = view.showCollidersOnly
    && diagnosticRole === "confounder"
    && !isIv
    && !isDv;
  const isPathMediator = (view.showConfoundersOnly || view.showCollidersOnly || view.showExogeneity)
    && diagnosticRole === "mediator" && !isIv && !isDv && !isInstrument;
  const overlapBorder = !isIv && !isDv && !isInstrument
    ? view.showConfoundersOnly && view.colliderGroupIds?.has(group.group_id) ? "#801744"
      : view.showCollidersOnly && view.confounderGroupIds?.has(group.group_id) ? "#c62828" : null
    : null;
  const isSelected = group.group_id === view.activeGroupId;
  const color = isViolation ? "#c62828" : isInstrument ? "#166534" : isExogeneityCandidate ? "#c62828" : isConfounder ? "#c62828" : isCollider ? "#801744" : isPathMediator ? "#6b7280" : view.groupColor;
  const roleTag = view.focusId && group.group_id === view.focusId ? " (focus)" : isIv ? " (Ind var)" : isDv ? " (Dep var)" : isInstrument ? " (instrument)" : isViolation ? " (exclusion restriction violation)" : isExogeneityCandidate ? " (potential common cause of instrument and Dep var)" : "";
  const mediatorTag = isPathMediator ? " · path mediator" : "";
  const maxChars = layoutParams.nodeMaxWidth <= 170 ? 18 : 22;
  return {
    id: group.group_id,
    label: wrapDagLabel(group.label, maxChars),
    title: isConfounder || isCollider || isExogeneityCandidate
      ? undefined
      : `${escapeHtml(group.label)}${roleTag} · ${group.variable_ids.length || group.member_count || 0} variables${mediatorTag}`,
    x: layoutPoint?.x || 0,
    y: layoutPoint?.y || 0,
    fixed: { x: true, y: true },
    mass: 1 + Math.min(3, Math.sqrt(group.variable_ids.length || group.member_count || 1) / 6),
    color: {
      background: color,
      border: overlapBorder || (isSelected ? "#b83b5e" : isViolation ? "#7f1d1d" : isConfounder || isExogeneityCandidate ? "#7f1d1d" : isCollider ? "#550f2d" : isPathMediator ? "#374151" : "#fbfcfa"),
      highlight: { background: color, border: overlapBorder || (isConfounder || isExogeneityCandidate ? "#4c0d0d" : isCollider ? "#380a1e" : isPathMediator ? "#1f2937" : "#b83b5e") },
      hover: { background: color, border: overlapBorder || "#ffffff" },
    },
    shape: (isIv || isDv || isInstrument) ? "ellipse" : "box",
    borderWidth: overlapBorder ? 4 : isSelected ? 3 : 2.4,
    ...(overlapBorder ? { borderWidthSelected: 4 } : {}),
    // Light outline keeps dense links visually separated from node bodies.
    shadow: isSelected
      ? { enabled: true, color: "rgba(184,59,94,0.45)", size: 12, x: 0, y: 0 }
      : isConfounder || isExogeneityCandidate
        ? { enabled: true, color: "rgba(198,40,40,0.34)", size: 11, x: 0, y: 2 }
        : isCollider
          ? { enabled: true, color: "rgba(128,23,68,0.34)", size: 11, x: 0, y: 2 }
        : isPathMediator
          ? { enabled: true, color: "rgba(55,65,81,0.28)", size: 9, x: 0, y: 2 }
      : { enabled: true, color: "rgba(25, 38, 34, 0.14)", size: 7, x: 0, y: 2 },
  };
}

export function edgeVisualData(link, selectedEdgeId) {
  const isSelected = link.edge_id === selectedEdgeId;
  const isTarget = link.is_target_relation;
  return {
    color: {
      color: isSelected ? "#b83b5e" : isTarget ? "#1e4fa0" : "#7ba096",
      highlight: "#b83b5e",
      hover: "#805214",
      inherit: false,
      opacity: isSelected ? 0.95 : isTarget ? 0.74 : 0.38,
    },
    dashes: false,
    width: isSelected ? 3.6 : isTarget ? 2.6 : 1.0,
  };
}

export function edgeHoverText(link, groups) {
  const { sourceLabel, targetLabel, arrow } = directedGroupLabels(link, groups, "<->");
  const lines = [`${sourceLabel} ${arrow} ${targetLabel}`];
  if (link.is_target_relation) lines.push("Target relation");
  const supportingTests = new Set([
    ...(link.a_to_b_raw_link_ids || []),
    ...(link.b_to_a_raw_link_ids || []),
  ]).size;
  lines.push(`Supporting test${supportingTests === 1 ? "" : "s"}: ${supportingTests}`);
  return lines.join("\n");
}

export function displayPaperTableKey(key) {
  const [paper, ...occurrenceParts] = String(key || "").split("::");
  const occurrence = occurrenceParts.join("::");
  if ((!paper || paper === "unknown") && (!occurrence || occurrence === "unknown")) return "";
  if (!occurrence || occurrence === "unknown") return paper;
  if (!paper || paper === "unknown") return `Occurrence ${occurrence}`;
  return `${paper}::${occurrence}`;
}


export function groupMapCentroid(group, variableById, clusterRep = id => id) {
  if (!variableById.size) return { x: 0, y: 0 };
  let x = 0, y = 0, count = 0;
  for (const id of group.variable_ids || []) {
    const variable = variableById.get(clusterRep(id));
    if (!variable) continue;
    x += Number(variable.map_x || 0);
    y += Number(variable.map_y || 0);
    count++;
  }
  return count ? { x: x / count, y: y / count } : { x: 0, y: 0 };
}
