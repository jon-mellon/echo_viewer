import { PAPER_PIPELINE } from "./paper_pipeline_contract.mjs";
import { validateShape, SAFETY } from "./paper_model.mjs";
import { PERSON_UOA_VALUES } from "./dag_uoa.mjs";

export function pipelineClaims(extraction) {
  validateShape(extraction, PAPER_PIPELINE.extractionSchema);
  if (extraction.s === "no_variables_found") {
    if (extraction.v.length || extraction.l.length) throw new Error("no_variables_found requires an empty graph.");
    return [];
  }
  if (!extraction.v.length) throw new Error("Pipeline extraction success requires variables.");
  const variables = new Map();
  for (const variable of extraction.v) {
    if (variables.has(variable.vi)) throw new Error("Duplicate pipeline variable ID.");
    variables.set(variable.vi, variable);
  }
  const links = new Set();
  return extraction.l.map(link => {
    if (links.has(link.li)) throw new Error("Duplicate pipeline link ID.");
    links.add(link.li);
    if (new Set(link.s).size !== link.s.length) throw new Error("Pipeline link source IDs must be unique.");
    if ([...link.s, link.t].some(id => !variables.has(id))) throw new Error("Pipeline link references unknown variables.");
    const sources = link.s.map(id => variables.get(id)), target = variables.get(link.t);
    const person = variable => variable.a.some(unit => unit.split(',').some(part => PERSON_UOA_VALUES.has(part.trim().toLowerCase())));
    const eligible = link.e === "present" && sources.length === 1 && sources.every(person) && person(target)
      && ["implied_selection_on_observables", "selection_on_observables", "matching"].includes(link.d);
    return { id: link.li, text: `${sources.map(row => row.c).join(" + ")} → ${target.c}`,
      sourceSentences: [], pipelineLink: link, pipelineVariables: [...sources, target], eligible,
      eligibilityNote: eligible ? "Select to evaluate this observational claim against the full article."
        : "Outside this preview’s person-level, single-exposure observational review protocol." };
  });
}

export async function extractPipelineClaims(model) {
  const { title, abstract } = model.run.capture;
  const extraction = await model.structured("Extracting Echo pipeline claims", "", {}, PAPER_PIPELINE.extractionSchema, {
    messages: [{ role: "system", content: SAFETY }, { role: "system", content: PAPER_PIPELINE.extractionPrompt },
      { role: "user", content: `# Title\n\n${title.replace(/<[^>]+>/g, "")}\n\n# Abstract\n\n${abstract}` }],
    reasoning: { effort: PAPER_PIPELINE.extractionReasoning }, max_tokens: 8192, validateResult: pipelineClaims
  });
  const claims = pipelineClaims(extraction);
  model.run.pipelineExtraction = extraction;
  model.run.pipeline = { model: PAPER_PIPELINE.model, promptVersion: PAPER_PIPELINE.promptVersion,
    sourceRevision: PAPER_PIPELINE.sourceRevision, sourceHashes: PAPER_PIPELINE.sourceHashes };
  return claims;
}
