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
export function validateQualification(qualification, capture) {
  if (capture.coverage !== "full") throw new Error("Confirm that the supplied article text is complete before qualification. Abstract-only and partial captures cannot be evaluated.");
  if (!qualification.eligible) throw new Error(qualification.reason || "This claim is outside the implemented protocol.");
  if (!qualification.causal || qualification.exposureRandomized || qualification.usesDid
    || qualification.xUnit !== "person" || qualification.yUnit !== "person"
    || !["implicit_selection_on_observables", "selection_on_observables", "matching"].includes(qualification.design)
    || !qualification.controls.length) throw new Error("The protocol requires a person-level nonrandomized observational causal estimate with measured adjustment; difference-in-differences is unsupported.");
  for (const field of ["x", "y", "population", "assignment", "evidenceLocation", "evidenceQuote", "adjustmentQuote"]) {
    if (!qualification[field]?.trim()) throw new Error(`Qualification is missing ${field}.`);
  }
  for (const quote of [qualification.evidenceQuote, qualification.adjustmentQuote]) {
    if (!capture.articleText.includes(quote)) throw new Error("Qualification quotations must occur exactly in the confirmed article text.");
  }
  if (qualification.articleHasRandomizedComponent && !qualification.mixedMethodsBoundary.trim()) throw new Error("Identify the boundary between the observational and randomized components.");
}
