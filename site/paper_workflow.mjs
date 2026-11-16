import { reportProgress } from "./paper_progress.mjs";
import { extractPipelineClaims } from "./paper_pipeline.mjs";
import { object, array, string, boolean, validateShape } from "./paper_model.mjs";
import { validateQualification, validateQualificationResult, NO_ADJUSTMENT_IDENTIFIED_NOTICE } from "./paper_capture.mjs";
import { digest, materializeQueue, reviewCoverage, validateFindingDecision, requiredIds } from "./paper_review_contract.mjs";
import { createEchoTools } from "./echo_tools.mjs";
import { CONFOUNDER_STATUSES, MANUAL_REVIEW_NOTICE } from "./confounder_status.mjs";
import { validateGroupingSchema } from "./data_validation.mjs";
import { unaddressedAssessmentNotice, VALIDATION_NOTICE } from "./paper_review_copy.mjs";

export const qualificationSchema = object({ eligible: { ...boolean, description: "Within scope for confounder scrutiny, not an endorsement of causal identification. Unadjusted, potentially confounded observational causal claims are eligible." }, reason: string,
  causal: { ...boolean, description: "The authors explicitly or implicitly interpret the selected relationship causally. This does not mean the estimate identifies a causal effect; no adjustment is required." },
  x: string, y: string, xUnit: string, yUnit: string, population: string, design: string,
  exposureRandomized: boolean, usesDid: boolean, assignment: string, controls: array(string),
  evidenceLocation: string, evidenceQuote: string, adjustmentQuote: string,
  articleHasRandomizedComponent: boolean, mixedMethodsBoundary: string });
const assessmentSchema = object({ status: { type: "string", enum: Object.keys(CONFOUNDER_STATUSES) },
  reason: string, systematicallyDifferent: boolean, splitReason: string,
  rejectedPaths: array(object({ id: string, reason: string })) });
const findingSchema = object({ decision: { type: "string", enum: ["retained", "excluded"] },
  reason: string, reason_code: { type: "string", enum: ["", "not_relevant_to_target_population", "concept_miscategorized", "other"] },
  questioned_end: { type: "string", enum: ["", "source", "target", "both"] }, undeniable: boolean });
const normalizeDoi = value => String(value || "").trim().replace(/^https?:\/\/(?:dx\.)?doi.org\//i, "").toLowerCase();
const lookupKey = ids => JSON.stringify([...new Set(ids)].sort());

export async function extractClaims(model) {
  reportProgress(model, "extract", "Extracting claims", "Reading the abstract for causal claims. You will choose which claim to review.");
  return extractPipelineClaims(model);
}
export async function qualifyClaim(model) {
  reportProgress(model, "qualify", "Checking the selected claim", "Reading the full text and identifying the focal estimate and its controls.");
  const result = await model.structured("Qualifying selected claim", `Verify the selected claim against the full captured text. Identify the actual focal estimate and its evidence location, X/Y measurements, person-level units, population, assignment, design and adjustment inventory.
Person-level nonrandomized observational claims are eligible when the authors state or imply a causal interpretation, including protective/harmful effects or causal explanations of observational associations. Formal causal terminology and adjustment are NOT prerequisites. An observational association alone without any explicit or implied causal interpretation is not enough. Do not reject a causal interpretation merely because the focal estimate is crude or unadjusted: missing adjustment is something the confounder review must examine.
No DiD, instruments, randomized estimates, purely noncausal descriptions or other units. If contradicted, unavailable, unsupported, or insufficient for those requirements, eligible=false and explain. Use design="observational" for observational estimates without a more specific supported design. Fields unavailable must be empty, not guesses. Give an exact evidence quotation. Build the adjustment inventory for the selected focal estimate only; do not transfer covariates from a different exposure, contrast or model. If no adjustment is identified for this estimate, controls=[] and adjustmentQuote="" are valid and must not make the claim ineligible. Describe this as "No adjustment identified in the captured text", not proof that the authors made no adjustment. When controls are identified, give an exact adjustment quotation. Separate randomized components of mixed-method papers. Verify exactly the selected pipeline link and its endpoint concepts; do not substitute another claim.`, { pipelineLink: model.run.selectedClaim?.pipelineLink, pipelineVariables: model.run.selectedClaim?.pipelineVariables }, qualificationSchema, { validateResult: value => validateQualificationResult(value, model.run.capture) });
  return validateQualificationResult(result, model.run.capture);
}

const setupNames = new Set(["echo_status", "echo_groups", "echo_search_variables", "echo_variables", "echo_neighbors", "echo_group_neighbors", "echo_findings", "echo_graph",
  "echo_upsert_group", "echo_assign_variables", "echo_remove_variables", "echo_split", "echo_browse_published_splits", "echo_apply_published_split",
  "echo_jev_estimate", "echo_jev_test", "echo_jev_full", "echo_jev_override", "echo_jev_apply_split", "echo_set_anchors", "echo_diff"]);

export async function setupAnchors(model, session, instruction = "Set up the focal X and Y.") {
  const run = model.run;
  const tools = createEchoTools({ getSession: () => session }).filter(tool => setupNames.has(tool.name));
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const messages = model.context(`Use Echo's tools to set up precise, substantively defensible focal anchors, then finish with a short explanation.
Search groups and variables; inspect actors and units. Reuse appropriate existing groups or approved published splits. Search published splits for the exact source groups before ANY manual or Jev split. Retain meaningful residual labels and boundaries. Never invent a variable occurrence for the focal paper. Focal variables genuinely absent from the snapshot are an explicit limitation.
For Jev: estimate, test, inspect test classifications, revise definition if needed, full classify, inspect output, override focal placement when necessary, then apply. No blind split. A split must preserve the focal variables when present.
${instruction}`, { statuses: CONFOUNDER_STATUSES });
  run.publishedLookups ||= {};
  run.toolResults ||= {};
  for (let step = 0; step < 40; step++) {
    reportProgress(model, "setup", "Matching the exposure and outcome", `Matching and checking ECHO concepts · reasoning step ${step + 1}.`);
    const message = await model.call("Setting up Echo variables", { messages,
      tools: tools.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) });
    messages.push(message);
    if (!message.tool_calls?.length) {
      if (!session.record.anchors.ivId || !session.record.anchors.dvId) throw new Error("Setup ended without verified X and Y anchors.");
      run.setupExplanation = message.content;
      return;
    }
    for (const call of message.tool_calls) {
      model.signal?.throwIfAborted();
      const tool = byName.get(call.function?.name);
      let result;
      try {
        if (Object.hasOwn(run.toolResults, call.id)) {
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(run.toolResults[call.id]) });
          continue;
        }
        if (!tool) throw new Error("Tool is outside this workflow.");
        const args = JSON.parse(call.function.arguments);
        const labels = { echo_search_variables: "Searching for matching variables", echo_groups: "Inspecting concept groups", echo_variables: "Checking variable definitions", echo_findings: "Reading supporting studies", echo_neighbors: "Exploring related concepts", echo_group_neighbors: "Exploring related concept groups", echo_graph: "Checking the evidence graph", echo_browse_published_splits: "Looking for existing concept splits", echo_apply_published_split: "Applying an existing concept split", echo_split: "Refining concept definitions", echo_jev_test: "Testing a concept classification", echo_jev_full: "Classifying variables", echo_jev_apply_split: "Applying a checked concept split", echo_set_anchors: "Setting the exposure and outcome" };
        reportProgress(model, "setup", "Matching the exposure and outcome", labels[tool?.name] || "Checking the concept definitions and evidence");
        validateShape(args, tool.inputSchema);
        if (["echo_split", "echo_jev_estimate", "echo_jev_test"].includes(tool.name)
          && !run.publishedLookups[lookupKey(args.sourceGroupIds || [])]) throw new Error("Browse published splits for these exact source groups first.");
        if (tool.name === "echo_jev_apply_split" && !session.record.jev?.fullComplete) throw new Error("A complete Jev test and full run are required.");
        // Local tool decisions and their journal share one durable IndexedDB record.
        session.runtime.operationId = call.id;
        try {
          result = session.record.operations.some(row => row.operationId === call.id)
            ? session.summary() : await tool.run(args);
        } finally { session.runtime.operationId = null; }
        if (tool.name === "echo_browse_published_splits") run.publishedLookups[lookupKey(args.sourceGroupIds)] = true;
        run.tools ||= [];
        run.tools.push({ id: call.id, name: tool.name, args, revision: session.record.revision });
        run.toolResults[call.id] = result;
        await model.save();
      } catch (error) {
        if (run.pending || model.signal?.aborted) throw error;
        result = { error: error.message };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error("Setup reached the 40-step limit. The private checkpoint is available for inspection.");
}

export async function evaluatePaper(model, session) {
  const run = model.run;
  if (await digest(run.capture) !== run.captureHash) throw new Error("The paper changed after confirmation. Start a new review.");
  validateQualification(run.qualification, run.capture);
  reportProgress(model, "setup", "Matching the exposure and outcome", "Checking focal measurements against the reference evidence.");
  if (!run.focalVariables) {
    const matches = run.capture.doi ? await session.evidence.searchVariables(run.capture.doi, 100) : [];
    const normalize = value => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
    run.focalVariables = Object.fromEntries(["x", "y"].map(role => [role, matches.filter(row => normalizeDoi(row.paper_id) === normalizeDoi(run.capture.doi)
      && [row.concept_label, row.raw_variable_text, row.display_label].some(label => normalize(label) === normalize(run.qualification[role])))
      .map(row => row.canonical_variable_id || row.variable_id)]));
    await model.save();
  }
  session.requiredFocal = run.focalVariables;
  if (!run.setupDone) {
    await setupAnchors(model, session);
    run.setupDone = true;
    await model.save();
  }
  const { ivId, dvId } = session.record.anchors;
  if (!run.queue) {
    reportProgress(model, "map", "Finding potential confounders", "Building the evidence graph and collecting the relevant findings.");
    const graph = await session.graph({ maxPathLength: 1, showConfoundersOnly: true });
    run.queue = await materializeQueue({ call: async (name, args) => name === "echo_findings"
      ? session.evidence.rawLinks(args.rawLinkIds) : session.evidence.variables(args.variableIds) }, graph, ivId, dvId);
    run.review = { findings: {}, confounders: {}, split_assessments: {} };
    run.initialGraph = graph;
    await model.save();
  }
  const queue = run.queue, review = run.review;
  for (const groupId of queue.confounderIds) {
    if (review.confounders[groupId]) continue;
    const group = session.schema.groups.find(row => row.group_id === groupId);
    const legs = queue.links.filter(link => link.source_group_id === groupId);
    reportProgress(model, "assess", "Assessing potential confounders", `Checking ${group.label}.`);
    const assessment = await model.structured(`Assessing ${group.label}`, `Assess whether K means systematically different things on K→X and K→Y, invalidating a common-confounder inference. If a split is required, say so and explain boundaries; do not dismiss an independent remainder.
Build the selected focal estimate's control inventory and choose exactly one supplied status with a detailed reason. Unadjusted observational causal claims are valid review targets. Credit controls only if they apply to this focal exposure/contrast/model; do not borrow covariates from the paper's other models. An empty inventory is valid and should lead to evidence-based confounder assessments, not rejection of the review. Credit defensible pre-treatment proxies and fixed effects with limitations. Precise measurement, limited samples or observed effect patterns alone do not establish design control. not_in_minimal_adjustment_set requires tracing paths and naming actual adjusted blockers.
causes_y_only_via_x must reject EVERY alternate direct or two-link route in the supplied graph, each with a reason. Use id=direct for K→Y and an intermediate group ID for K→Z→Y. Other statuses require rejectedPaths=[].`,
      { group, legs, statuses: CONFOUNDER_STATUSES, graph: run.initialGraph.dag.edges }, assessmentSchema);
    if (assessment.systematicallyDifferent) {
      run.phase = "split_required";
      run.splitRequired = { groupId, reason: assessment.splitReason };
      await model.save();
      throw new Error(`A substantive split is required for ${group.label}: ${assessment.splitReason}. Use Resolve split to rebuild and review the changed graph.`);
    }
    const rejected = Object.fromEntries(assessment.rejectedPaths.map(row => [row.id, row.reason]));
    await session.setConfounderStatus({ groupId, status: assessment.status, text: assessment.reason,
      rejectedPaths: assessment.rejectedPaths.map(row => row.id) });
    review.confounders[groupId] = { status: assessment.status, reason: assessment.reason,
      ...(assessment.status === "unaddressed" ? { assessmentNotice: unaddressedAssessmentNotice(group.label) } : {}),
      ...(assessment.rejectedPaths.length ? { rejected_paths: rejected } : {}) };
    review.split_assessments[groupId] = { systematically_different: false, reason: assessment.splitReason || assessment.reason };
    await model.save();
  }
  reportProgress(model, "findings", "Checking supporting findings", "Reviewing the supporting studies for relevance and independence.");
  // Process the shorter leg first; preserve the order of findings within each link.
  const links = [...queue.links].sort((a, b) => {
    if (a.source_group_id !== b.source_group_id) return queue.links.indexOf(a) - queue.links.indexOf(b);
    return a.findings.length - b.findings.length || queue.links.indexOf(a) - queue.links.indexOf(b);
  });
  for (const link of links) {
    const status = review.confounders[link.source_group_id]?.status;
    if (["explicitly_controlled", "accounted_for_by_design"].includes(status)) continue;
    const otherLeg = links.find(other => other !== link && other.source_group_id === link.source_group_id && other.source_group_id !== ivId);
    if (otherLeg?.findings.length && otherLeg.findings.every(row => review.findings[row.raw_link_id]?.decision === "excluded")) continue;
    for (const finding of link.findings) {
      if (!requiredIds(link, review.findings, run.capture.doi).includes(finding.raw_link_id)) break;
      if (review.findings[finding.raw_link_id]) continue;
      reportProgress(model, "findings", "Checking supporting findings", `Checking evidence for ${session.schema.groups.find(row => row.group_id === link.source_group_id)?.label || "a potential confounder"}.`);
      const focal = normalizeDoi(finding.paper_doi) && normalizeDoi(finding.paper_doi) === normalizeDoi(run.capture.doi);
      const decision = focal ? { decision: "excluded", reason: "The focal paper cannot supply independent supporting evidence for its own review.", reason_code: "other", undeniable: false }
        : await model.structured("Judging supporting finding", `Judge this finding against BOTH endpoint definitions, units/actors, target population and reported design. Retain only a relevant causal finding. Exclusions use the supplied exact categories. concept_miscategorized must be justified by membership in its own group, never by comparison with the focal paper; identify questioned_end only for this category. Use empty strings for inapplicable reason_code/questioned_end. A retained finding is undeniable only if clearly relevant. Missing DOI cannot count as an independent paper. Give an open evidence-based reason.`,
          { finding, source: session.schema.groups.find(row => row.group_id === link.source_group_id), target: session.schema.groups.find(row => row.group_id === link.target_group_id) }, findingSchema);
      if (!decision.reason_code) delete decision.reason_code;
      if (!decision.questioned_end) delete decision.questioned_end;
      if (!normalizeDoi(finding.paper_doi)) decision.undeniable = false;
      validateFindingDecision(decision, finding.raw_link_id);
      await session.setFindingDecision({ rawLinkId: finding.raw_link_id, excluded: decision.decision === "excluded",
        reasonCode: decision.reason_code || "", reasonText: decision.reason });
      review.findings[finding.raw_link_id] = decision;
      if (decision.reason_code === "concept_miscategorized") {
        run.miscodingFlags ||= {};
        for (const [end, groupId, variableId] of [["source", link.source_group_id, finding.source_variable_id], ["target", link.target_group_id, finding.target_variable_id]]) {
          if ([end, "both"].includes(decision.questioned_end)) {
            run.miscodingFlags[groupId] = [...new Set([...(run.miscodingFlags[groupId] || []), variableId])];
          }
        }
      }
      await model.save();
    }
  }
  reportProgress(model, "validate", "Validating the review", "Checking evidence coverage and the completed review before showing the result.");
  const coverage = reviewCoverage([queue], review, {}, run.capture.doi);
  for (const operation of session.record.operations.filter(row => ["split", "edit_split"].includes(row.name))) {
    const group = session.schema.groups.find(row => row.group_id === operation.args.newGroupId);
    if (!group?.variable_ids.length) continue;
    const flagged = (run.miscodingFlags?.[group.group_id] || []).filter(id => group.variable_ids.includes(id));
    if (flagged.length * 4 > group.variable_ids.length) {
      run.splitRequired = { groupId: group.group_id, reason: `More than a quarter of this split's members have independent concept-miscoding flags (${flagged.length}/${group.variable_ids.length}); revise its substantive boundary.` };
      run.phase = "split_required"; await model.save();
      throw new Error(run.splitRequired.reason);
    }
  }
  validateGroupingSchema(session.schema);
  run.outcome = { format: "echo-paper-review-v1", captureHash: run.captureHash, claim: run.selectedClaim,
    qualification: run.qualification,
    ...(!run.qualification.controls.length ? { adjustmentNotice: NO_ADJUSTMENT_IDENTIFIED_NOTICE } : {}),
    anchors: session.record.anchors,
    publicationId: session.record.sourcePublication.id, schemaHash: session.record.sourcePublication.content_hash,
    physicalSnapshotId: session.record.snapshotId, evidenceManifestHash: session.record.evidenceManifestHash,
    focalVariableMatches: run.focalVariables, linkReviews: coverage.linkReviews,
    review, statusLabels: CONFOUNDER_STATUSES, reviewNotice: MANUAL_REVIEW_NOTICE, validationNotice: VALIDATION_NOTICE, model: run.model, usage: run.calls,
    limitations: [MANUAL_REVIEW_NOTICE, "AI review does not establish identification or quantify bias.",
      "No previous private finding judgments or private split library were reused.",
      "Missing focal variable occurrences are not manufactured; inspect anchor membership and measurement correspondence.",
      "This version does not separately assess whether a confounder duplicates the exposure or outcome definition.",
      "Review is limited to distance-one confounders; longer causal paths and unknown evidence remain limitations."] };
  run.phase = "complete";
  reportProgress(model, "complete", "Review complete", "The result and supporting decisions have been saved privately.");
  await model.save();
  return run.outcome;
}

export async function resolveSplit(model, session) {
  const run = model.run;
  if (!run.splitRequired) throw new Error("There is no pending split.");
  if ((run.splitRounds || 0) >= 3) throw new Error("The three-round split limit was reached. This review cannot be marked complete.");
  reportProgress(model, "setup", "Refining concept definitions", "A concept needs a clearer definition. Revising the split before rebuilding the evidence graph.");
  const before = session.record.operations.length;
  session.requiredFocal = run.focalVariables;
  await setupAnchors(model, session, `Resolve this meaning difference with a justified split, preserving the focal anchors: ${JSON.stringify(run.splitRequired)}. Inspect and test before applying.`);
  if (!session.record.operations.slice(before).some(operation => ["split", "edit_split"].includes(operation.name))) throw new Error("No split was applied.");
  run.splitRounds = (run.splitRounds || 0) + 1;
  run.splitRequired = null;
  run.queue = null;
  run.review = null;
  run.phase = "split_applied";
  await model.save();
}
