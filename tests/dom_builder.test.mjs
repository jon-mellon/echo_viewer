import test from "node:test";
import assert from "node:assert/strict";
import { h, replaceChildren, safeUrl, setSafeUrl } from "../site/dom_builder.mjs";

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.listeners = {};
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
}

test.before(() => {
  globalThis.document = { createElement: tagName => new FakeNode(tagName) };
});

test.after(() => {
  delete globalThis.document;
});

test("h treats hostile strings as text instead of markup", () => {
  const hostile = `<img src=x onerror="globalThis.pwned=true">`;
  const node = h("button", { textContent: hostile, dataset: { id: `"><script>` } });
  assert.equal(node.textContent, hostile);
  assert.equal(node.dataset.id, `"><script>`);
  assert.deepEqual(node.children, []);
  assert.equal(globalThis.pwned, undefined);
});

test("h attaches event listeners without inline handler attributes", () => {
  const listener = () => {};
  const node = h("button", { onclick: listener });
  assert.equal(node.listeners.click, listener);
  assert.deepEqual(node.attributes, {});
});

test("URL helpers accept web and blob URLs and reject executable protocols", () => {
  assert.equal(safeUrl("/schema/123", "https://example.test/app"), "https://example.test/schema/123");
  assert.equal(safeUrl("blob:https://example.test/id"), "blob:https://example.test/id");
  assert.throws(() => safeUrl("javascript:alert(1)"), /Unsafe URL protocol/);
  assert.throws(() => safeUrl("data:text/html,<script>alert(1)<\/script>"), /Unsafe URL protocol/);

  const link = new FakeNode("a");
  setSafeUrl(link, "href", "https://example.test/");
  assert.equal(link.href, "https://example.test/");
  assert.throws(() => setSafeUrl(link, "action", "https://example.test/"), /Unsupported URL property/);
});

test("replaceChildren flattens builders and drops absent children", () => {
  const parent = new FakeNode("div");
  replaceChildren(parent, ["one", null, ["two", false]], undefined);
  assert.deepEqual(parent.children, ["one", "two"]);
});
