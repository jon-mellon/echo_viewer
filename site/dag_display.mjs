import { confounderPathNodeRole } from "./dag_graph.mjs";
import { wrapDagLabel } from "./dag_layout.mjs";
import { directedGroupLabels } from "./dag_exports.mjs";
import { escapeHtml } from "./text_utils.mjs";

// Display records only: no renderer, DOM or viewer-state access.

// Okabe-Ito, the colour-blind-safe palette, used softened throughout the DAG.
export const OKABE_ITO = {
  orange: "#E69F00", sky: "#56B4E9", green: "#009E73", yellow: "#F0E442",
  blue: "#0072B2", vermillion: "#D55E00", purple: "#CC79A7", grey: "#999999",
};
const DAG_SURFACE = "#f8f8f8";

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mix `a` toward `b` by `t` (0 = a, 1 = b); returns an opaque hex colour. */
export function mixHex(a, b, t) {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const channel = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`;
}

// Edges are drawn opaque, pre-blended with the canvas, so the arrowhead hides
// the line under it and segments of one routed edge never darken where they meet.
export const softEdge = (hex, strength) => mixHex(DAG_SURFACE, hex, strength);
const TARGET_EDGE_COLOR = softEdge(OKABE_ITO.blue, 0.85);
const PLAIN_EDGE_COLOR = softEdge(OKABE_ITO.sky, 0.6);

function isDark(hex) {
  const [r, g, b] = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 150;
}

/** Hovering keeps the node's size: only border colour and fill shift. */
export function chosenNodeHover(values, _id, selected, hovering) {
  if (!hovering || selected) return;
  values.borderColor = OKABE_ITO.blue;
  values.color = mixHex(values.color, "#ffffff", 0.18);
}
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
    ? view.showConfoundersOnly && view.colliderGroupIds?.has(group.group_id) ? OKABE_ITO.purple
      : view.showCollidersOnly && view.confounderGroupIds?.has(group.group_id) ? OKABE_ITO.vermillion : null
    : null;
  const isSelected = group.group_id === view.activeGroupId;
  const color = isViolation ? OKABE_ITO.vermillion : isInstrument ? OKABE_ITO.green : isExogeneityCandidate ? OKABE_ITO.vermillion : isConfounder ? OKABE_ITO.vermillion : isCollider ? OKABE_ITO.purple : isPathMediator ? OKABE_ITO.grey : view.groupColor;
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
      border: overlapBorder || (isSelected ? OKABE_ITO.orange : isViolation || isConfounder || isExogeneityCandidate || isCollider || isPathMediator || isInstrument ? mixHex(color, "#000000", 0.35) : "#fbfcfa"),
      highlight: { background: color, border: overlapBorder || OKABE_ITO.orange },
      hover: { background: color, border: overlapBorder || OKABE_ITO.blue },
    },
    font: { color: isDark(color) ? "#ffffff" : "#1b2420" },
    chosen: { node: chosenNodeHover, label: false },
    shape: (isIv || isDv || isInstrument) ? "ellipse" : "box",
    borderWidth: overlapBorder ? 4 : isSelected ? 3 : 2.4,
    ...(overlapBorder ? { borderWidthSelected: 4 } : {}),
    // Light outline keeps dense links visually separated from node bodies.
    shadow: isSelected
      ? { enabled: true, color: "rgba(230,159,0,0.5)", size: 12, x: 0, y: 0 }
      : isConfounder || isExogeneityCandidate
        ? { enabled: true, color: "rgba(213,94,0,0.30)", size: 11, x: 0, y: 2 }
        : isCollider
          ? { enabled: true, color: "rgba(204,121,167,0.36)", size: 11, x: 0, y: 2 }
        : isPathMediator
          ? { enabled: true, color: "rgba(153,153,153,0.34)", size: 9, x: 0, y: 2 }
      : { enabled: true, color: "rgba(25, 38, 34, 0.14)", size: 7, x: 0, y: 2 },
  };
}

export function edgeVisualData(link, selectedEdgeId) {
  const isSelected = link.edge_id === selectedEdgeId;
  const isTarget = link.is_target_relation;
  return {
    color: {
      color: isSelected ? OKABE_ITO.vermillion : isTarget ? TARGET_EDGE_COLOR : PLAIN_EDGE_COLOR,
      highlight: OKABE_ITO.vermillion,
      hover: OKABE_ITO.orange,
      inherit: false,
      opacity: 1,
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
