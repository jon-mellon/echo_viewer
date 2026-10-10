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
  setAttribute(name, value) { this[name] = value; }
  click() { this.listeners.get("click")?.(); }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    const match = selector.match(/^\[data-([\w-]+)(?:='([^']+)')?\]$/);
    if (!match) return [];
    const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const matches = [];
    for (const child of this.children) {
      if (!(child instanceof Element)) continue;
      if (Object.hasOwn(child.dataset, key) && (match[2] === undefined || child.dataset[key] === match[2])) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
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

test("concepts used by visible DAG links appear before other group concepts", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tagName => new Element(tagName) };
  try {
    const ids = Array.from({ length: 13 }, (_, index) => `v${index + 1}`);
    const state = {
      project: { groups: [{ group_id: "g1", label: "Variable", description: "Existing definition", variable_ids: ids }] },
      selectedEvidenceGroupId: "g1", variableById: new Map(), rawLinksById: new Map(),
      visibleLinks: [{ group_a: "g1", group_b: "g2", a_to_b_raw_link_ids: ["r1", "r2", "r3"] }],
    };
    const elements = { edgeInspector: new Element("div"), closeEvidencePane: new Element("button"),
      provenancePanel: new Element("div") };
    const labelRequests = [];
    const endpointRequests = [];
    const controller = createDagInspectorController({ state, elements,
      loadVisibleLinkEndpoints: requested => {
        endpointRequests.push(requested);
        return [
          { raw_causal_link_id: "r1", source_variable_id: "v12", target_variable_id: "v20" },
          { raw_causal_link_id: "r2", source_variable_id: "v12", target_variable_id: "v21" },
          { raw_causal_link_id: "r3", source_variable_id: "v11", target_variable_id: "v22" },
        ];
      },
      loadConceptLabels: requested => {
        labelRequests.push(requested);
        return requested.map(variable_id => ({ variable_id, concept_label: `Concept ${variable_id}` }));
      },
    });

    controller.renderGroupDefinition();
    assert.match(elements.edgeInspector.textContent, /Existing definition/);
    assert.equal(endpointRequests.length, 0);
    assert.equal(labelRequests.length, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(endpointRequests[0], ["r1", "r2", "r3"]);
    assert.deepEqual(labelRequests[0], ["v12", "v11", ...ids.slice(0, 8)]);
    assert.match(elements.edgeInspector.textContent, /Concept v12/);
    assert.equal(elements.edgeInspector.findAll("li").length, 10);

    state.visibleLinks = [{ group_a: "g1", group_b: "g2", a_to_b_raw_link_ids: ["r3"] }];
    controller.renderGroupDefinition();
    assert.match(elements.edgeInspector.textContent, /Existing definition/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(endpointRequests.length, 1, "known raw link endpoints are reused");
    assert.equal(elements.edgeInspector.findAll("li")[0].findAll("span")[0].textContent, "Concept v11");
  } finally {
    globalThis.document = previousDocument;
  }
});

test("concept exclude control passes the selected concept to the group update path", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tagName => new Element(tagName) };
  try {
    const state = {
      project: { groups: [{ group_id: "g1", label: "Variable", description: "Definition", variable_ids: ["v1"] }] },
      selectedEvidenceGroupId: "g1", variableById: new Map([["v1", { concept_label: "Concept one" }]]),
    };
    const elements = { edgeInspector: new Element("div"), closeEvidencePane: new Element("button"),
      provenancePanel: new Element("div") };
    const exclusions = [];
    createDagInspectorController({ state, elements,
      excludeConcept: (...args) => exclusions.push(args),
    }).renderGroupDefinition();
    const button = elements.edgeInspector.querySelector("[data-exclude-concept-id]");
    assert.equal(button.textContent, "×");
    button.click();
    assert.deepEqual(exclusions, [["g1", "v1", "Concept one"]]);
  } finally {
    globalThis.document = previousDocument;
  }
});
