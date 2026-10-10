import test from "node:test";
import assert from "node:assert/strict";
import { createDagSetupGroupController } from "../site/dag_setup_group_controller.mjs";

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.ownText = "";
    this.scrollTop = 0;
  }

  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent || "").join(""); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.ownText = ""; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this[name] = value; }
  click() { this.listeners.get("click")?.(); }
  querySelectorAll(selector) {
    if (selector !== "details[data-group-id]") throw new Error(`Unexpected selector: ${selector}`);
    return this.findAll("details").filter(item => Object.hasOwn(item.dataset, "groupId"));
  }
  findAll(tagName) {
    return this.children.flatMap(child => child instanceof Element
      ? [...(child.tagName === tagName ? [child] : []), ...child.findAll(tagName)] : []);
  }
}

test("Variables panel shows ten per page and remembers expanded definitions", () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tagName => new Element(tagName) };
  try {
    const groups = Array.from({ length: 23 }, (_, index) => ({
      group_id: `g${index + 1}`, label: `Variable ${String(index + 1).padStart(2, "0")}`,
      variable_ids: [`v${index + 1}`], description: `Definition ${index + 1}`,
    }));
    const state = { interfaceMode: "dag2", project: { groups, iv_group_id: "g1", dv_group_id: "g2" } };
    const elements = { variablePanel: new Element("section"), variablePanelCount: new Element("span"),
      variablePanelList: new Element("div"), variablePanelPagination: new Element("div") };
    const controller = createDagSetupGroupController({ state, elements,
      groupById: id => state.project.groups.find(group => group.group_id === id) });

    controller.renderVariablePanel();
    assert.equal(elements.variablePanelCount.textContent, "23");
    assert.equal(elements.variablePanelList.findAll("details").length, 10);
    assert.match(elements.variablePanelList.textContent, /Definition 1/);
    assert.match(elements.variablePanelPagination.textContent, /1–10 of 23/);

    elements.variablePanelPagination.findAll("button")[1].click();
    assert.equal(elements.variablePanelList.findAll("details").length, 10);
    assert.match(elements.variablePanelPagination.textContent, /11–20 of 23/);
    elements.variablePanelList.findAll("details")[0].open = true;
    controller.renderVariablePanel();
    assert.equal(elements.variablePanelList.findAll("details")[0].open, true);

    elements.variablePanelPagination.findAll("button")[1].click();
    assert.equal(elements.variablePanelList.findAll("details").length, 3);
    assert.match(elements.variablePanelPagination.textContent, /21–23 of 23/);
    assert.equal(elements.variablePanelPagination.findAll("button")[1].disabled, true);
    elements.variablePanelPagination.findAll("button")[0].click();
    assert.equal(elements.variablePanelList.findAll("details")[0].open, true);

    state.project.groups = groups.slice(0, 2);
    controller.renderVariablePanel();
    assert.equal(elements.variablePanelList.findAll("details").length, 2);
    assert.equal(elements.variablePanelPagination.hidden, true);
  } finally {
    globalThis.document = previousDocument;
  }
});
