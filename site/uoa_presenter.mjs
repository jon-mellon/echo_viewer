import { PERSON_UOA_SENTINEL } from "./dag_uoa.mjs";
import { h, replaceChildren } from "./dom_builder.mjs";

export function createUoaPresenter({ state, elements, visibleVariables, matches, getAllParts,
  supportedByAnchors, truncate, onSelect, onRemoveSeed }) {
  function renderStep() {
    if (!elements.uoaChips) return;
    const parts = getAllParts();
    if (!parts.length) {
      replaceChildren(elements.uoaChips, h("p", { className: "small-note", textContent: "No unit-of-analysis data found." }));
      return;
    }
    const personCount = visibleVariables().filter(variable => matches(variable.uoa, PERSON_UOA_SENTINEL)).length;
    const chip = (part, count, disabled, combined = false) => h("button", {
      className: `uoa-chip${combined ? " uoa-chip-combined" : ""}${state.selectedUoa === part ? " active" : ""}`,
      type: "button", dataset: { uoa: part }, disabled,
      title: disabled ? `The selected IV and DV do not both contain ${combined ? "person-level variables" : "this unit of analysis"}` : "",
    }, combined ? "person (all)" : part, h("span", { className: "uoa-count", textContent: count }));
    replaceChildren(elements.uoaChips,
      personCount > 0 ? chip(PERSON_UOA_SENTINEL, personCount, !supportedByAnchors(PERSON_UOA_SENTINEL), true) : null,
      parts.map(([part, count]) => chip(part, count, !supportedByAnchors(part))));
    elements.uoaChips.querySelectorAll(".uoa-chip").forEach(button =>
      button.addEventListener("click", () => onSelect(button.dataset.uoa)));
  }

  function renderFilterBar() {
    if (!state.selectedUoa) {
      elements.uoaFilterBar.hidden = true;
      return;
    }
    elements.uoaFilterBar.hidden = false;
    elements.uoaSelectedLabel.textContent = state.selectedUoa === PERSON_UOA_SENTINEL ? "person (all)" : state.selectedUoa;
    elements.uoaFilterToggle.checked = state.uoaFilterEnabled;
  }

  function renderSeeds() {
    for (const [side, container] of [["iv", elements.ivSeeds], ["dv", elements.dvSeeds]]) {
      replaceChildren(container, [...state.seeds[side]].map(variableId => {
        const variable = state.variableById.get(variableId);
        return h("span", { className: "chip", title: variable?.display_label || variableId },
          truncate(variable?.display_label || variableId, 34),
          h("button", { type: "button", dataset: { side, variableId }, textContent: "×" }));
      }));
      container.querySelectorAll("button").forEach(button =>
        button.addEventListener("click", () => onRemoveSeed(button.dataset.side, button.dataset.variableId)));
    }
  }

  return { renderStep, renderFilterBar, renderSeeds };
}
