const { showPanel } = require("./navigation.cjs");

/** Identification's Cause, Outcome and Instrument fields share one picker list under them. */
async function openIdentifyField(page, side, { tap = false } = {}) {
  const input = page.locator(`#identify-${side}-input`);
  // On a phone the fields are on the list tab, and choosing both anchors moves to the map.
  if (!(await input.isVisible())) await showPanel(page, "controls", { tap });
  await (tap ? input.tap() : input.click());
}

async function chooseAnchor(page, side, groupId, { tap = false } = {}) {
  await openIdentifyField(page, side, { tap });
  const option = page.locator(`#identifyGroupPicker button[data-group-id="${groupId}"]`);
  await (tap ? option.tap() : option.click());
}

/** Cause (IV) then Outcome (DV); the instrument is optional and left empty. */
async function chooseAnchors(page, iv, dv, { tap = false } = {}) {
  await chooseAnchor(page, "iv", iv, { tap });
  await chooseAnchor(page, "dv", dv, { tap });
}

/** Opens a field's picker and presses its Create button, which defines a variable for that role. */
async function startCreate(page, side = "iv", { tap = false } = {}) {
  await openIdentifyField(page, side, { tap });
  const create = page.locator("#identifyGroupPicker .custom-create");
  await (tap ? create.tap() : create.click());
}

/** The Edit variable schema button under Variables on map; Create variable lives in that workspace. */
const editSchemaButton = page => page.locator("#editVariableSchema:visible").first();

/** Opens the schema workspace and presses Create variable, which defines a variable for no particular role. */
async function createVariableFromSchema(page) {
  const create = page.locator("#customVariablesCreate");
  if (!(await create.isVisible())) await editSchemaButton(page).click();
  await create.click();
}

/** A custom variable's Edit and Delete icon buttons in a list row. */
const editVariableButton = (page, label) => page.getByRole("button", { name: `Edit ${label}`, exact: true });

module.exports = { editSchemaButton, createVariableFromSchema, editVariableButton, openIdentifyField, chooseAnchor, chooseAnchors, startCreate };
