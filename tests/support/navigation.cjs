/** On a phone the top bar's controls sit behind a hamburger button; elsewhere this does nothing. */
async function openNav(page, { tap = false } = {}) {
  const toggle = page.locator("#navToggle");
  if (!(await toggle.isVisible())) return;
  if ((await toggle.getAttribute("aria-expanded")) === "true") return;
  await (tap ? toggle.tap() : toggle.click());
}

async function closeNav(page, { tap = false } = {}) {
  const toggle = page.locator("#navToggle");
  if (!(await toggle.isVisible())) return;
  if ((await toggle.getAttribute("aria-expanded")) !== "true") return;
  await (tap ? toggle.tap() : toggle.click());
}

/** Chooses a view from the start page or the task menu. "causes" and "consequences" are the two directions of Exploration. */
async function chooseTask(page, task, { tap = false } = {}) {
  const press = locator => (tap ? locator.tap() : locator.click());
  const exploring = task === "causes" || task === "consequences";
  const target = exploring ? "explore" : task;
  // Before any task is chosen the start page is the way in.
  if (await page.locator("#taskLanding").isVisible()) {
    await press(page.locator(`#taskLanding button[data-task=${target}]`));
    if (exploring) await chooseDirection(page, task, { tap });
    return;
  }
  await openNav(page, { tap });
  if (!(await page.locator("#taskMenu").evaluate(menu => menu.open))) await press(page.locator("#taskMenuToggle"));
  await press(page.locator(`#taskMenu .task-tab[data-task=${target}]`));
  if (exploring) await chooseDirection(page, task, { tap });
  await closeNav(page, { tap });
}

async function chooseDirection(page, direction, { tap = false } = {}) {
  const button = page.locator(`#exploreDirection button[data-direction=${direction}]`);
  if ((await button.getAttribute("aria-pressed")) === "true") return;
  await openNav(page, { tap });
  await (tap ? button.tap() : button.click());
  await closeNav(page, { tap });
}

/** Shows a phone panel ("controls" or "dag"); a no-op where there are no panel tabs. */
async function showPanel(page, panel, { tap = false } = {}) {
  const tab = page.locator(`.mobile-panel-nav [data-mobile-panel="${panel}"]`);
  if (await tab.isVisible()) await (tap ? tab.tap() : tab.click());
}

/** Picks the Exploration variable, reopening the picker first when a variable is already chosen. */
async function chooseFocus(page, groupId, { tap = false } = {}) {
  const picker = page.locator("#focusGroupPicker");
  if (!(await page.locator("#focusInput").isVisible())) await showPanel(page, "controls", { tap });
  if (!(await picker.isVisible())) await (tap ? page.locator("#focusInput").tap() : page.locator("#focusInput").click());
  const option = page.locator(`#focusGroupPicker button[data-group-id="${groupId}"]`);
  await (tap ? option.tap() : option.click());
}

module.exports = { openNav, closeNav, chooseTask, chooseDirection, showPanel, chooseFocus };
