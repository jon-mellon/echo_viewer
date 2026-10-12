import assert from "node:assert/strict";
import { test } from "node:test";
import { cappedKeyStatus, randomSampleIds, spotCheckResults } from "../site/definition_jev_assist.mjs";

test("Jev access requires a non-resetting key capped at $5", () => {
  assert.equal(cappedKeyStatus({ limit: 5, limit_reset: null, limit_remaining: 4.5 }), null);
  assert.match(cappedKeyStatus({ limit: null, limit_reset: null, limit_remaining: null }), /Set a spending limit/);
  assert.match(cappedKeyStatus({ limit: 5.01, limit_reset: null, limit_remaining: 5.01 }), /Lower its limit/);
  assert.match(cappedKeyStatus({ limit: 5, limit_reset: "daily", limit_remaining: 5 }), /never resets/);
  assert.match(cappedKeyStatus({ limit: 5, limit_reset: null, limit_remaining: 0 }), /no spending allowance/);
});

test("a 30,000-variable run has a bounded spot check from both sides", () => {
  const results = Array.from({ length: 30_000 }, (_, index) => ({
    id: `variable-${index}`, side: index % 2 ? "new" : "leftover",
    confidence: index === 29_999 ? 0.51 : 0.8,
  }));
  const spot = spotCheckResults(results);
  assert.ok(spot.length <= 36);
  assert.ok(spot.some(item => item.id === "variable-29999"));
  assert.ok(spot.some(item => item.side === "new"));
  assert.ok(spot.some(item => item.side === "leftover"));
  assert.deepEqual(spotCheckResults(results).map(item => item.id), spot.map(item => item.id));
});

test("a 30,000-variable split can draw its fixed test sample", () => {
  const source = Array.from({ length: 30_000 }, (_, index) => `variable-${index}`);
  const sample = randomSampleIds(source);
  assert.equal(sample.length, 24);
  assert.equal(new Set(sample).size, 24);
  assert.equal(source.length, 30_000);
  assert.ok(sample.every(id => source.includes(id)));
});
