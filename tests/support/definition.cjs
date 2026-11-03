/** Fills the Describe step that now opens every definition: a name and a definition of at least 20 characters. */
async function describeVariable(page, { label = "Browser test variable", description = "A browser test variable with enough definition." } = {}) {
  await page.locator("#definitionNewLabel").fill(label);
  await page.locator("#definitionNewDescription").fill(description);
  await page.locator("#definitionDescribeNext").click();
}

/** The name the concept list shows for a variable; its search matches names, not ids. */
const conceptLabel = (page, variableId) => page.evaluate(id => {
  const variable = window.__dagBuilderState.variableById.get(id);
  return variable?.display_label || variable?.concept_label || id;
}, variableId);

module.exports = { describeVariable, conceptLabel };
