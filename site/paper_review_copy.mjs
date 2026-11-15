export const VALIDATION_NOTICE = "Validation is not yet complete. Expert-review non-confirmation rate: x% (placeholder, not a measured result). Individual AI flags have not been independently verified and could be incorrect. Manually check the paper before treating a flag as an omission.";

export function unaddressedAssessmentNotice(label = "this potential confounder") {
  return `The AI could not identify adjustment for ${label} in the captured text. This confounder may be unaddressed, or adjustment may be described elsewhere. This individual AI flag has not been independently verified and could be incorrect. Manually review the methods and supplementary material before drawing conclusions.`;
}
