// Browser port of harvest_abstracts/analysis/echo_agent_demo/review_contract.mjs.
// Sampling/filesystem checks are replaced by confirmed capture qualification.
// Status IDs intentionally follow this checkout's six-status Echo UI contract.
import { CONFOUNDER_STATUSES as STATUSES } from "./confounder_status.mjs";
import { sha256Hex } from "./compiled_dag.mjs";
const QUESTIONED_ENDS = new Set(["source", "target", "both"]);
const EXCLUSION_CODES = new Set(["not_relevant_to_target_population", "concept_miscategorized", "other"]);
export const CONFOUNDER_STATUSES = new Set(Object.keys(STATUSES));
export const HANDLED_STATUSES = new Set(["explicitly_controlled", "accounted_for_by_design"]);
export const ONLY_VIA = "causes_y_only_via_x";
const FOCAL_PAPER_REASON = /\b(focal|this (paper|study|article|claim|finding|exposure|outcome|link|path)|the (paper|study|article)['\u2019]?s?)\b/i;
const nonempty = value => typeof value === "string" && Boolean(value.trim());
export const digest = value => sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
export function handledConfounders(confounders = {}) {
  return new Set(Object.entries(confounders).filter(([, row]) => HANDLED_STATUSES.has(row.status)).map(([id]) => id));
}
export function checkRejectedPaths(groupId, row) {
  const paths = row.rejected_paths;
  if (row.status !== ONLY_VIA) {
    if (paths !== undefined) throw new Error(`Confounder ${groupId}: rejected_paths belongs only to ${ONLY_VIA}.`);
    return;
  }
  if (paths === undefined) return;
  const entries = paths && typeof paths === "object" && !Array.isArray(paths) ? Object.entries(paths) : null;
  if (!entries?.length || entries.some(([, reason]) => !nonempty(reason) || reason.trim().length < 15)) {
    throw new Error(`Confounder ${groupId}: rejected_paths must be {"direct" or an intermediate group ID: reason}, each reason at least 15 characters saying which link is not a real effect on the outcome. Omit it when Echo lists no route.`);
  }
}

export function directionalIds(dag, from, to) {
  const edge = dag.edges.find(row =>
    (row.group_a === from && row.group_b === to) || (row.group_b === from && row.group_a === to));
  if (!edge) return [];
  return [...(edge.group_a === from ? edge.a_to_b_raw_link_ids : edge.b_to_a_raw_link_ids)];
}

/** The catch-all group is not a concept, so it can never be a candidate confounder. */
export const CATCH_ALL_GROUPS = new Set(["category-other"]);
export function residualGroupIds(groups = [], appliedSplits = {}) {
  return new Set([
    ...groups.filter(g => g.provenance?.source_group_ids_retained_as_residuals &&
      g.provenance.source_group_ids?.includes(g.group_id)).map(g => g.group_id),
    ...Object.values(appliedSplits).flatMap(s => s.source_group_ids || []),
  ]);
}
export function withoutCatchAllGroups(graph, residuals = []) {
  const excluded = new Set([...CATCH_ALL_GROUPS, ...residuals]);
  if (!graph?.view?.confounders?.confounderIds || !graph?.dag?.edges) return graph;
  return { ...graph,
    view: { ...graph.view, confounders: { ...graph.view.confounders,
      confounderIds: graph.view.confounders.confounderIds.filter(id => !excluded.has(id)) } },
    dag: { ...graph.dag, edges: graph.dag.edges.filter(edge => !excluded.has(edge.group_a) && !excluded.has(edge.group_b)) } };
}

/**
 * Put findings that earlier evaluations kept before ones they rejected, within each link. Tiers: kept before (most
 * keeps first), no history, excluded only for population or other reasons, flagged miscategorized. Stable otherwise,
 * so with no history the order is unchanged. `history` maps raw_link_id to { retained: [...], excluded: {...} }.
 */
export function orderByHistory(links, history = {}) {
  const kept = id => (history[id]?.retained || []).length;
  const tier = id => {
    const entry = history[id];
    if (!entry) return 1;
    if ((entry.excluded?.miscategorized || []).length) return 3;
    if (kept(id)) return 0;
    return (entry.excluded?.population || []).length + (entry.excluded?.other || []).length ? 2 : 1;
  };
  for (const link of links) {
    const ranked = link.findings.map((row, index) => ({ row, index }))
      .sort((a, b) => tier(a.row.raw_link_id) - tier(b.row.raw_link_id) || kept(b.row.raw_link_id) - kept(a.row.raw_link_id) || a.index - b.index)
      .map(item => item.row);
    link.findings = ranked;
    link.raw_link_ids = ranked.map(row => row.raw_link_id);
  }
  return links;
}

/** Findings kept by at least five distinct focal papers: they can no longer be flagged concept_miscategorized. */
export function protectedFindings(history = {}, threshold = 5) {
  return new Set(Object.entries(history).filter(([, entry]) => (entry.retained || []).length >= threshold).map(([id]) => id));
}

export function evidencePlan(graph, ivId, dvId) {
  if (!graph?.dag?.edges || !graph?.view?.confounders?.confounderIds) {
    throw new Error("Echo graph must include the DAG and confounder view.");
  }
  const confounderIds = graph.view.confounders.confounderIds;
  const links = confounderIds.flatMap(groupId => [ivId, dvId].map(to => ({
    edge_id: `${groupId}->${to}`, source_group_id: groupId, target_group_id: to,
    raw_link_ids: directionalIds(graph.dag, groupId, to),
  })));
  links.push({ edge_id: `${ivId}->${dvId}`, source_group_id: ivId, target_group_id: dvId,
    raw_link_ids: directionalIds(graph.dag, ivId, dvId) });
  return { ivId, dvId, confounderIds, links };
}

export async function materializeQueue(client, graph, ivId, dvId) {
  const plan = evidencePlan(graph, ivId, dvId);
  const ids = [...new Set(plan.links.flatMap(link => link.raw_link_ids))];
  const raw = [];
  for (let start = 0; start < ids.length; start += 500) {
    raw.push(...await client.call("echo_findings", { rawLinkIds: ids.slice(start, start + 500), limit: 500 }));
  }
  const rawById = new Map(raw.map(row => [row.raw_causal_link_id, row]));
  if (rawById.size !== ids.length || ids.some(id => !rawById.has(id))) {
    throw new Error("Echo returned an incomplete finding batch.");
  }
  const variableIds = [...new Set(raw.flatMap(row => [row.source_variable_id, row.target_variable_id]))];
  const variables = [];
  for (let start = 0; start < variableIds.length; start += 500) {
    variables.push(...await client.call("echo_variables", { variableIds: variableIds.slice(start, start + 500) }));
  }
  const byVariable = new Map(variables.map(row => [row.variable_id, row]));
  if (variableIds.some(id => !byVariable.has(id))) throw new Error("Echo returned incomplete variable metadata.");
  const links = plan.links.map(link => ({ ...link, findings: link.raw_link_ids.map(id => {
    const row = rawById.get(id), source = byVariable.get(row.source_variable_id), target = byVariable.get(row.target_variable_id);
    return { raw_link_id: id, paper_doi: row.paper_id, paper_title: row.paper_title,
      target_population: row.target_population, identification_strategy: row.identification_strategy,
      source_variable_id: row.source_variable_id, source_concept: source.concept_label || source.display_label,
      source_uoa: source.uoa, target_variable_id: row.target_variable_id,
      target_concept: target.concept_label || target.display_label, target_uoa: target.uoa,
      raw_finding: row, source_variable: source, target_variable: target };
  }) }));
  return { ...plan, links, created_at: new Date().toISOString(), graph_hash: await digest(graph.dag.edges) };
}

export function mergedEvidence(queues) {
  if (!Array.isArray(queues) || !queues.length) throw new Error("At least one pinned evidence queue is required.");
  const links = new Map();
  const confounderIds = new Set();
  for (const queue of queues) {
    for (const id of queue.confounderIds) confounderIds.add(id);
    for (const link of queue.links) {
      let found = links.get(link.edge_id);
      if (!found) { found = { edge_id: link.edge_id, findings: [] }; links.set(link.edge_id, found); }
      for (const finding of link.findings) {
        if (!found.findings.some(row => row.raw_link_id === finding.raw_link_id)) found.findings.push(finding);
      }
    }
  }
  return { links: [...links.values()], confounderIds: [...confounderIds] };
}

export function validateFindingDecision(decision, id) {
  if (!decision || !["retained", "excluded"].includes(decision.decision) || !nonempty(decision.reason)) {
    throw new Error(`Finding ${id} needs a decision and open reason.`);
  }
  if (decision.decision === "excluded" && !EXCLUSION_CODES.has(decision.reason_code)) {
    throw new Error(`Finding ${id} needs an Echo exclusion reason code.`);
  }
  if (decision.decision === "retained" && decision.reason_code) {
    throw new Error(`Retained finding ${id} cannot have an exclusion code.`);
  }
  if (decision.reason_code === "concept_miscategorized" && !QUESTIONED_ENDS.has(decision.questioned_end)) {
    throw new Error(`Finding ${id} needs questioned_end (source, target or both) for a miscategorized concept.`);
  }
  if (decision.reason_code === "concept_miscategorized" && FOCAL_PAPER_REASON.test(decision.reason)) {
    throw new Error(`Finding ${id}: concept_miscategorized must be justified by the concept and its group alone, not by the focal paper. ` +
      "If the finding only does not fit this paper's population, use not_relevant_to_target_population or other.");
  }
  if (decision.questioned_end && (decision.decision !== "excluded" || !QUESTIONED_ENDS.has(decision.questioned_end))) {
    throw new Error(`Finding ${id} has an invalid questioned_end.`);
  }
  if (decision.undeniable && decision.decision !== "retained") {
    throw new Error(`Excluded finding ${id} cannot be undeniable support.`);
  }
}

export function requiredIds(link, decisions, focalDoi = "") {
  const focal = String(focalDoi || "").trim().toLowerCase();
  const papers = new Set();
  const required = [];
  for (const row of link.findings) {
    required.push(row.raw_link_id);
    const decision = decisions[row.raw_link_id];
    const doi = String(row.paper_doi || "").trim().toLowerCase();
    if (decision?.undeniable && decision.decision === "retained" && doi && doi !== focal) papers.add(doi);
    if (papers.size >= 5) break;
  }
  return required;
}

/**
 * Which findings each link must have decided. Normally all of a link's findings, or those up to five independent
 * undeniable papers (see requiredIds). A confounder needs evidence on both of its links, so once one leg is fully
 * decided with nothing retained, the other leg needs no review at all: the confounder cannot be in the final graph.
 * Returns { required: Map(edge -> ids), clearedBy: Map(edge -> the cleared leg that made it optional) }.
 */
export function requirementsByEdge(links, confounderIds, ivId, dvId, decisions, focalDoi = "", handled = new Set()) {
  const byEdge = new Map(links.map(link => [link.edge_id, link]));
  const required = new Map(links.map(link => [link.edge_id, requiredIds(link, decisions, focalDoi)]));
  const clearedBy = new Map(), handledEdges = new Set();
  for (const confounder of confounderIds) {
    const legs = [`${confounder}->${ivId}`, `${confounder}->${dvId}`];
    if (handled.has(confounder)) {  // status came first: a controlled or by-design confounder needs no judged evidence
      for (const edge of legs) if (byEdge.has(edge)) { required.set(edge, []); handledEdges.add(edge); }
      continue;
    }
    legs.forEach((edge, index) => {
      const link = byEdge.get(edge), other = legs[1 - index];
      if (!link || !byEdge.has(other)) return;
      const cleared = link.findings.length > 0 && link.findings.every(row => decisions[row.raw_link_id])
        && !link.findings.some(row => decisions[row.raw_link_id].decision === "retained");
      if (cleared) { required.set(other, []); clearedBy.set(other, edge); }
    });
  }
  return { required, clearedBy, handledEdges };
}

export function reviewCoverage(queues, review, appliedSplits = {}, focalDoi = "") {
  const evidence = mergedEvidence(queues);
  const decisions = review?.findings || {};
  const known = new Set(evidence.links.flatMap(link => link.findings.map(row => row.raw_link_id)));
  for (const id of Object.keys(decisions)) {
    if (!known.has(id)) throw new Error(`Review contains finding ${id} outside the pinned queues.`);
    validateFindingDecision(decisions[id], id);
  }
  const linkReviews = [];
  const latestQueue = queues.at(-1);
  const { required: requiredByEdge, clearedBy, handledEdges } = requirementsByEdge(evidence.links, evidence.confounderIds, latestQueue.ivId,
    latestQueue.dvId, decisions, focalDoi, handledConfounders(review.confounders));
  for (const link of evidence.links) {
    const ordered = link.findings.map(row => row.raw_link_id);
    const reviewed = ordered.filter(id => decisions[id]);
    const required = requiredByEdge.get(link.edge_id);
    const missing = required.filter(id => !decisions[id]);
    if (missing.length) {
      throw new Error(`${link.edge_id} has ${missing.length} unreviewed finding(s) in queue order and fewer than five independent undeniable papers.`);
    }
    const undeniable = [...new Set(link.findings.filter(row => decisions[row.raw_link_id]?.undeniable)
      .map(row => row.paper_doi).filter(doi => String(doi || "").trim().toLowerCase() !== focalDoi.trim().toLowerCase()))];
    const fiveReached = requiredIds(link, decisions, focalDoi).length < ordered.length;
    const stopRule = reviewed.length === ordered.length ? "all_reviewed" : handledEdges.has(link.edge_id) ? "confounder_handled"
      : fiveReached ? "five_independent" : "other_leg_cleared";
    const notes = { all_reviewed: "All pinned findings on this link were reviewed.",
      confounder_handled: "The paper's specification already accounts for this confounder, so its evidence was not judged.",
      five_independent: "Five independent undeniable papers reached the stop rule.",
      other_leg_cleared: `The confounder's other link (${clearedBy.get(link.edge_id)}) has no retained finding, so there is no confounding path and this link needed no further review.` };
    linkReviews.push({ edge_id: link.edge_id, total_findings: ordered.length,
      reviewed_finding_ids: reviewed, undeniable_supporting_dois: undeniable,
      stop_rule: stopRule, ...(stopRule === "other_leg_cleared" ? { cleared_by_edge: clearedBy.get(link.edge_id) } : {}),
      note: review.link_notes?.[link.edge_id] || notes[stopRule] });
  }
  for (const groupId of evidence.confounderIds) {
    const status = review.confounders?.[groupId];
    if (!status || !CONFOUNDER_STATUSES.has(status.status) || !nonempty(status.reason)) {
      throw new Error(`Confounder ${groupId} needs an open reason and one of these exact statuses: ${[...CONFOUNDER_STATUSES].join(", ")}.`);
    }
    checkRejectedPaths(groupId, status);
    const assessment = review.split_assessments?.[groupId];
    if (!assessment || typeof assessment.systematically_different !== "boolean" || !nonempty(assessment.reason)) {
      throw new Error(`Confounder ${groupId} needs a split assessment of whether differing meanings undermine the combined confounder inference.`);
    }
    if (assessment.systematically_different) {
      for (const field of ["exposure_examples", "outcome_examples", "why_not_confounder", "new_group_rationale", "residual_group_rationale", "boundary_cases"]) {
        if (!nonempty(assessment[field]) || assessment[field].trim().length < 15) throw new Error(`Confounder ${groupId} split needs a specific ${field} (at least 15 characters).`);
      }
    }
    if (assessment.systematically_different &&
        (!nonempty(assessment.split_id) || !appliedSplits[assessment.split_id])) {
      throw new Error(`Confounder ${groupId} needs an applied Jev split.`);
    }
  }
  return { evidence, linkReviews, decisions };
}

