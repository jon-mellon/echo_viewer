export function unaddressedAssessmentNotice(label = "this potential confounder") {
  return `The AI could not identify adjustment for ${label} in the captured text. This confounder may be unaddressed, or adjustment may be described elsewhere. Manually review the methods and supplementary material before drawing conclusions.`;
}
