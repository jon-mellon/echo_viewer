/** Fills the Describe step that now opens every definition: a name and a definition of at least 20 characters. */
async function describeVariable(page, { label = "Browser test variable", description = "A browser test variable with enough definition." } = {}) {
  await page.locator("#definitionNewLabel").fill(label);
  await page.locator("#definitionNewDescription").fill(description);
  await page.locator("#definitionDescribeNext").click();
}

/** From the Create click to the AI panel: describe, pick a source, Next, then "Suggest with AI". */
async function startAiSplit(page, { source = "academic achievement", label, description } = {}) {
  await describeVariable(page, { label, description });
  await page.locator("#definitionSourceList .definition-source-row").filter({ hasText: source }).first().click();
  await page.locator("#definitionContinue").click();
  await page.locator("#definitionPartitionStep").waitFor();
  await page.locator("#definitionMethodJev").click();
  await page.locator("#definitionJevPanel").waitFor();
}

/** The name the concept list shows for a variable; its search matches names, not ids. */
const conceptLabel = (page, variableId) => page.evaluate(id => {
  const variable = window.__dagBuilderState.variableById.get(id);
  return variable?.display_label || variable?.concept_label || id;
}, variableId);

module.exports = { describeVariable, conceptLabel, startAiSplit };
