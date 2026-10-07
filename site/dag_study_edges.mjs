import { STUDY_DESIGN_EDGE_ID, STUDY_INSTRUMENT_EDGE_ID } from "./dag_inspector_controller.mjs";

export function studyDesignEdgeData(groups, project) {
  const groupIds = new Set(groups.map(group => group.group_id));
  const ivId = project?.iv_group_id;
  const dvId = project?.dv_group_id;
  if (!groupIds.has(ivId) || !groupIds.has(dvId) || ivId === dvId) return [];
  const evidence = project?.links?.find(link => link.is_target_relation);
  const evidenceCount = evidence
    ? new Set([...(evidence.a_to_b_raw_link_ids || []), ...(evidence.b_to_a_raw_link_ids || [])]).size
    : 0;
  const style = {
    arrows: { to: { enabled: true, scaleFactor: 1.15 } },
    color: {
      color: "#168a52", highlight: "#168a52", hover: "#168a52",
      inherit: false, opacity: 1,
    },
    width: 5.5,
    selectionWidth: 0,
    chosen: true,
    smooth: { enabled: false },
    shadow: { enabled: true, color: "rgba(22,138,82,0.32)", size: 8, x: 0, y: 1 },
  };
  const edges = [{ ...style, id: STUDY_DESIGN_EDGE_ID, from: ivId, to: dvId,
    title: `Selected study relationship: IV → DV (not an evidence link). ${evidenceCount} evidence record(s) attached.` }];
  const instrumentId = project?.instrument_group_id;
  if (groupIds.has(instrumentId) && instrumentId !== ivId && instrumentId !== dvId) {
    edges.push({ ...style, id: STUDY_INSTRUMENT_EDGE_ID, from: instrumentId, to: ivId,
      title: "Selected study relationship: Instrument → IV (not an evidence link)." });
  }
  return edges;
}
