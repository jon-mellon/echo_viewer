import test from "node:test";
import assert from "node:assert/strict";
import { createDagInspectorController } from "../site/dag_inspector_controller.mjs";

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.ownText = "";
  }

  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent || "").join(""); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.ownText = ""; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  click() { this.listeners.get("click")?.(); }
  querySelector(selector) {
    const match = selector.match(/^\[data-([\w-]+)(?:='([^']+)')?\]$/);
    if (!match) return null;
    const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    for (const child of this.children) {
      if (!(child instanceof Element)) continue;
      if (Object.hasOwn(child.dataset, key) && (match[2] === undefined || child.dataset[key] === match[2])) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  findAll(tagName) {
    return this.children.flatMap(child => child instanceof Element
      ? [...(child.tagName === tagName ? [child] : []), ...child.findAll(tagName)] : []);
  }
}

test("group definition renders before concepts and paginates ten at a time", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tagName => new Element(tagName) };
  try {
    const ids = Array.from({ length: 23 }, (_, index) => `v${index + 1}`);
    const group = { group_id: "g1", label: "Variable", description: "Existing definition", variable_ids: ids };
    const state = { project: { groups: [group] }, selectedEvidenceGroupId: "g1", variableById: new Map() };
    const elements = { edgeInspector: new Element("div"), closeEvidencePane: new Element("button"),
      provenancePanel: new Element("div") };
    const requests = [];
    const controller = createDagInspectorController({ state, elements, loadConceptLabels: requested => {
      requests.push(requested);
      return Promise.resolve(requested.map(variable_id => ({ variable_id, concept_label: `Concept ${variable_id}` })));
    } });

    assert.equal(controller.renderGroupDefinition(), true);
    assert.match(elements.edgeInspector.textContent, /Existing definition/);
    assert.equal(requests.length, 0, "concept retrieval starts after the definition is rendered");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests[0], ids.slice(0, 10));
    assert.equal(elements.edgeInspector.findAll("li").length, 10);
    assert.match(elements.edgeInspector.textContent, /Concept v1/);

    elements.edgeInspector.querySelector("[data-concept-page='next']").click();
    assert.match(elements.edgeInspector.textContent, /Existing definition/);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests[1], ids.slice(10, 20));
    assert.equal(elements.edgeInspector.findAll("li").length, 10);

    elements.edgeInspector.querySelector("[data-concept-page='next']").click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests[2], ids.slice(20));
    assert.equal(elements.edgeInspector.findAll("li").length, 3);

    elements.edgeInspector.querySelector("[data-concept-page='previous']").click();
    assert.equal(requests.length, 3, "previously loaded pages are cached");
  } finally {
    globalThis.document = previousDocument;
  }
});
