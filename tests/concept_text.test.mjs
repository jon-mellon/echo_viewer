import assert from "node:assert/strict";
import test from "node:test";
import { conceptWithUoaHint } from "../site/concept_text.mjs";

test("only the first uoa on a screen gets the explanation", () => {
  const element = tag => ({ tagName: tag, style: {}, dataset: {}, children: [], setAttribute() {}, addEventListener() {}, append(...nodes) { this.children.push(...nodes); } });
  globalThis.document = { createElement: element, createTextNode: text => text };
  const hint = { shown: false };
  const first = conceptWithUoaHint("uoa's self-reported amusement", hint);
  assert.equal(first.length, 3);
  assert.equal(first[0], "");
  assert.equal(first[2], "'s self-reported amusement");
  assert.deepEqual(conceptWithUoaHint("uoa's second concept", hint), ["uoa's second concept"]);
  assert.deepEqual(conceptWithUoaHint("no placeholder", { shown: false }), ["no placeholder"]);
});
