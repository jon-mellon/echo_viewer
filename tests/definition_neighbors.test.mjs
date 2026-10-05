import test from "node:test";
import assert from "node:assert/strict";
import { nearbyMapNeighbors } from "../site/definition_neighbors.mjs";

test("map fallback returns closest eligible leftover variables", () => {
  const variables = new Map([
    ["selected", { map_x: 0, map_y: 0 }],
    ["near", { map_x: 1, map_y: 1 }],
    ["far", { map_x: 8, map_y: 0 }],
    ["missing", {}],
    ["outside", { map_x: 0, map_y: 0 }],
  ]);
  const results = nearbyMapNeighbors(["selected", "far", "missing", "near"], ["selected"], variables);
  assert.deepEqual(results.map(result => result.variable_id), ["near", "far"]);
  assert.equal(results[0].map_distance, true);
  assert.equal(results[0].distance, 2);
});

test("map fallback uses closest selected origin, bounds results, and handles missing coordinates", () => {
  const variables = new Map([["a", { map_x: 0, map_y: 0 }], ["b", { map_x: 100, map_y: 0 }]]);
  for (let index = 0; index < 30; index++) variables.set(`v${index}`, { map_x: 100 + index, map_y: 0 });
  const eligible = [...variables.keys()];
  assert.deepEqual(nearbyMapNeighbors(eligible, ["a", "b"], variables, 2)
    .map(result => result.variable_id), ["v0", "v1"]);
  assert.deepEqual(nearbyMapNeighbors(eligible, ["unknown"], variables), []);
});
