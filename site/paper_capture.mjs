import { PERSON_UOA_VALUES } from "./dag_uoa.mjs";
import { digest } from "./paper_review_contract.mjs";
export function validateCapture(input) {
  if (!input || typeof input !== "object") throw new Error("A paper capture is required.");
  const result = {};
  for (const field of ["sourceUrl", "title", "doi", "abstract", "articleText", "extractionMethod", "capturedAt"]) {
    if (typeof input[field] !== "string") throw new Error(`Missing capture field: ${field}.`);
    result[field] = input[field].trim();
  }
  if (result.sourceUrl && !["https:", "http:"].includes(new URL(result.sourceUrl).protocol)) throw new Error("Use an HTTP article URL.");
  if (result.articleText.length > 500000 || result.abstract.length > 50000 || result.title.length > 2000) throw new Error("Capture exceeds the supported text size. Supply the relevant article text.");
  result.doi = result.doi.replace(/^https?:\/\/(?:dx\.)?doi.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase();
  if (result.doi && !/^10\.\d{4,9}\/\S+$/i.test(result.doi)) throw new Error("The DOI format is invalid; correct it or leave it blank.");
  if (!["full", "partial", "abstract_only", "unknown"].includes(input.coverage)) throw new Error("Choose the text coverage.");
  result.coverage = input.coverage;
  return result;
}
export async function confirmedCapture(input) {
  const capture = validateCapture(input);
  if (!capture.title || !capture.abstract) throw new Error("Supply a title and the actual abstract before extracting claims.");
  return { capture, captureHash: await digest(capture) };
}
export function validateClaims(claims, abstract) {
  if (!claims.length) return claims;
  const ids = new Set();
  for (const claim of claims) {
    if (!claim.id?.trim() || ids.has(claim.id) || !claim.text?.trim() || !claim.sourceSentences?.length
      || claim.sourceSentences.some(sentence => !sentence.trim() || !abstract.includes(sentence))) {
      throw new Error("Every claim needs a unique ID, wording, and exact sentence(s) from the abstract.");
    }
    ids.add(claim.id);
  }
  return claims;
}
const designName = qualification => String(qualification.design || "").trim().toLowerCase().replace(/[- ]+/g, "_");
const isDid = qualification => qualification.usesDid || ["diff_in_diff", "difference_in_differences", "did"].includes(designName(qualification));
const personAliases = new Set(["individual", "individuals", "human individual", "human individuals", "people", "person-year", "person-years", "person-waves", "participant", "participants", "patient", "patients", "respondent", "respondents", "adults", "older adult", "older adults"]);
const isPerson = unit => PERSON_UOA_VALUES.has(String(unit).trim().toLowerCase()) || personAliases.has(String(unit).trim().toLowerCase());
function verifyDesignEvidence(qualification, capture) {
  if (isDid(qualification) && (!qualification.designEvidenceQuote?.trim() || !capture.articleText.includes(qualification.designEvidenceQuote))) {
    throw new Error("The AI returned a difference-in-differences classification without a verified supporting quotation. That classification was not accepted; it does not establish that the paper uses this design.");
  }
}
export function validateQualification(qualification, capture) {
  if (capture.coverage !== "full") throw new Error("Confirm that the supplied article text is complete before qualification. Abstract-only and partial captures cannot be evaluated.");
  if (!qualification.eligible) throw new Error(qualification.reason || "This claim is outside the implemented protocol.");
  if (!qualification.causal) throw new Error("The AI did not identify an explicit or implied causal interpretation for this claim in the captured text. This assessment may be incomplete; manually check the authors’ interpretation.");
  if (qualification.exposureRandomized) throw new Error("The AI classified the selected exposure as randomized. This preview reviews nonrandomized observational claims; manually verify the assignment for this specific estimate.");
  verifyDesignEvidence(qualification, capture);
  if (isDid(qualification)) throw new Error(`The AI classified this estimate as difference-in-differences, outside this preview’s scope. Check its cited evidence: “${qualification.designEvidenceQuote}”. The classification may be incorrect.`);
  if (!isPerson(qualification.xUnit) || !isPerson(qualification.yUnit)) throw new Error(`The AI reported exposure unit “${qualification.xUnit}” and outcome unit “${qualification.yUnit}”. This preview requires person-level units. Check the selected measurements; the AI may have mislabeled the units.`);
  const supportedDesigns = ["implicit_selection_on_observables", "implied_selection_on_observables", "selection_on_observables", "matching", "observational", "cohort", "cohort_study", "observational_cohort", "prospective_cohort", "longitudinal_cohort", "cox_regression", "cox_proportional_hazards", "survival_analysis", "regression"];
  if (!supportedDesigns.includes(designName(qualification))) throw new Error(`The AI returned design “${qualification.design || "unspecified"}”, which this preview cannot evaluate. This may be a classification error; check the focal estimate’s actual design.`);
  for (const field of ["x", "y", "population", "assignment", "evidenceLocation", "evidenceQuote"]) {
    if (!qualification[field]?.trim()) throw new Error(`Qualification is missing ${field}.`);
  }
  if (qualification.controls.length && !qualification.adjustmentQuote?.trim()) throw new Error("Identified controls require an exact adjustment quotation.");
  for (const quote of [qualification.evidenceQuote, qualification.adjustmentQuote].filter(Boolean)) {
    if (!capture.articleText.includes(quote)) throw new Error("Qualification quotations must occur exactly in the confirmed article text.");
  }
  if (qualification.articleHasRandomizedComponent && !qualification.mixedMethodsBoundary.trim()) throw new Error("Identify the boundary between the observational and randomized components.");
}

// A negative qualification is a valid review outcome, distinct from a failed call.
export function validateQualificationResult(qualification, capture) {
  verifyDesignEvidence(qualification, capture);
  // Do not let the model's extra eligibility flag veto an otherwise supported
  // observational causal claim solely because its control inventory is empty.
  // The original model answer remains in the durable response receipt.
  if (!qualification.eligible && Array.isArray(qualification.controls) && !qualification.controls.length) {
    const candidate = { ...qualification, eligible: true };
    try {
      validateQualification(candidate, capture);
      return { ...candidate, eligibilityBasis: "The structured evidence meets the observational causal-claim scope. Missing adjustment does not exclude it from confounder scrutiny; the model's original eligibility flag is retained in the response receipt." };
    } catch { /* Other scope or evidence failures remain valid rejections. */ }
  }
  if (qualification.eligible) validateQualification(qualification, capture);
  else if (!qualification.reason?.trim()) throw new Error("An unqualified claim needs an explanation.");
  return qualification;
}

export const NO_ADJUSTMENT_IDENTIFIED_NOTICE = "No adjustment identified in the captured text. This is an AI assessment, not confirmation that the authors made no adjustment. Manually review the focal estimate’s methods, tables and supplementary material.";
