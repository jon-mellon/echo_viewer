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

test("Variables panel shows ten per page and remembers expanded definitions", async () => {
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
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    globalThis.document = previousDocument;
  }
});

test("expanded Variables row loads concepts in pages and keeps the definition visible", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tagName => new Element(tagName) };
  try {
    const ids = Array.from({ length: 12 }, (_, index) => `v${index + 1}`);
    const groups = [
      { group_id: "g1", label: "Variable", variable_ids: ids, description: "Existing definition" },
      { group_id: "g2", label: "Outcome", variable_ids: ["outcome"] },
    ];
    const state = { interfaceMode: "dag2", project: { groups, iv_group_id: "g1", dv_group_id: "g2" },
      variableById: new Map(), rawLinksById: new Map([["r1", { raw_causal_link_id: "r1",
        source_variable_id: "v12", target_variable_id: "outcome" }]]),
      visibleLinks: [{ group_a: "g1", group_b: "g2", a_to_b_raw_link_ids: ["r1"] }] };
    const elements = { variablePanel: new Element("section"), variablePanelCount: new Element("span"),
      variablePanelList: new Element("div"), variablePanelPagination: new Element("div") };
    const requests = [];
    const exclusions = [];
    const controller = createDagSetupGroupController({ state, elements,
      groupById: id => groups.find(group => group.group_id === id),
      loadConceptLabels: requested => {
        requests.push(requested);
        return requested.map(variable_id => ({ variable_id, concept_label: `Concept ${variable_id}` }));
      },
      excludeConcept: (...args) => exclusions.push(args),
    });

    controller.renderVariablePanel();
    const row = elements.variablePanelList.findAll("details")[1];
    assert.match(row.textContent, /Existing definition/);
    assert.equal(requests.length, 0, "collapsed rows do not load concepts");
    row.open = true;
    row.listeners.get("toggle")();
    assert.match(row.textContent, /Existing definition/);
    assert.equal(requests.length, 0, "the definition appears before concept loading starts");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests[0], ["v12", ...ids.slice(0, 9)]);
    assert.equal(row.findAll("li").length, 10);
    assert.equal(row.findAll("li")[1].className, "group-concept-boundary");
    row.findAll("li")[0].findAll("button")[0].click();
    assert.deepEqual(exclusions, [["g1", "v12", "Concept v12"]]);

    row.findAll("div").find(item => item.className === "group-concept-pagination")
      .findAll("button")[1].click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests[1], ids.slice(9, 11));
    assert.equal(row.findAll("li").length, 2);
  } finally {
    globalThis.document = previousDocument;
  }
});
