import { confounderPathNodeRole } from "./dag_graph.mjs";
import { wrapDagLabel } from "./dag_layout.mjs";
import { directedGroupLabels } from "./dag_exports.mjs";
import { escapeHtml } from "./text_utils.mjs";

// Display records only: no renderer, DOM or viewer-state access.
export function visNodeData(group, layoutPoint, layoutParams = {}, view) {
  const isIv = group.type === "iv";
  const isDv = group.type === "dv";
  const diagnosticCandidateIds = view.showCollidersOnly
    ? view.colliderGroupIds
    : view.confounderGroupIds;
  const diagnosticPathIds = view.showCollidersOnly
    ? view.colliderPathGroupIds
    : view.confounderPathGroupIds;
  const diagnosticRole = confounderPathNodeRole({
    confounderIds: diagnosticCandidateIds,
    pathIds: diagnosticPathIds,
  }, group.group_id, {
    ivId: view.ivId,
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
  const isPathMediator = (view.showConfoundersOnly || view.showCollidersOnly)
    && diagnosticRole === "mediator";
  const isSelected = group.group_id === view.activeGroupId;
  const color = isConfounder ? "#c62828" : isCollider ? "#7c3aed" : isPathMediator ? "#6b7280" : view.groupColor;
  const roleTag = isIv ? " (IV)" : isDv ? " (DV)" : "";
  const mediatorTag = isPathMediator ? " · path mediator" : "";
  const maxChars = layoutParams.nodeMaxWidth <= 170 ? 18 : 22;
  return {
    id: group.group_id,
    label: wrapDagLabel(group.label, maxChars),
    title: isConfounder || isCollider
      ? undefined
      : `${escapeHtml(group.label)}${roleTag} · ${group.variable_ids.length || group.member_count || 0} variables${mediatorTag}`,
    x: layoutPoint?.x || 0,
    y: layoutPoint?.y || 0,
    fixed: { x: true, y: true },
    mass: 1 + Math.min(3, Math.sqrt(group.variable_ids.length || group.member_count || 1) / 6),
    color: {
      background: color,
      border: isSelected ? "#b83b5e" : isConfounder ? "#7f1d1d" : isCollider ? "#4c1d95" : isPathMediator ? "#374151" : "#fbfcfa",
      highlight: { background: color, border: isConfounder ? "#4c0d0d" : isCollider ? "#2e1065" : isPathMediator ? "#1f2937" : "#b83b5e" },
      hover: { background: color, border: "#ffffff" },
    },
    shape: (isIv || isDv) ? "ellipse" : "box",
    borderWidth: isSelected ? 3 : 2.4,
    // Light outline keeps dense links visually separated from node bodies.
    shadow: isSelected
      ? { enabled: true, color: "rgba(184,59,94,0.45)", size: 12, x: 0, y: 0 }
      : isConfounder
        ? { enabled: true, color: "rgba(198,40,40,0.34)", size: 11, x: 0, y: 2 }
        : isCollider
          ? { enabled: true, color: "rgba(124,58,237,0.34)", size: 11, x: 0, y: 2 }
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
    dashes: link.is_manual ? [6, 4] : false,
    width: isSelected ? 3.6 : isTarget ? 2.6 : 1.0,
  };
}

export function edgeHoverText(link, groups) {
  const { sourceLabel, targetLabel, arrow } = directedGroupLabels(link, groups, "<->");
  const lines = [`${sourceLabel} ${arrow} ${targetLabel}`];
  if (link.is_target_relation) lines.push("Target relation");
  if (link.is_manual) lines.push("Manual edge");
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
