import assert from "node:assert/strict";
import test from "node:test";
import { neighborhoodGraph } from "../site/task_views.mjs";
import { causalNeighborhood } from "../site/causal_neighborhood.mjs";

const keys = n => Array.from({ length: n }, (_, i) => `p${i}`);
const link = (a, b, direction, forward = 0, backward = 0) => ({
  edge_id: `${a}__${b}`, group_a: a, group_b: b, direction_type: direction,
  a_to_b_paper_table_keys: keys(forward), b_to_a_paper_table_keys: keys(backward), display_status: "active_by_default",
});

test("the graph uses the project's own links with arrows narrowed to the hops that qualified", () => {
  // b ↔ x is supported 3 papers b → x but only 1 paper x → b.
  const links = [link("b", "x", "BIDIRECTIONAL", 3, 1), link("c", "b", "A_TO_B", 2), link("x", "y", "A_TO_B", 5)];
  const rows = causalNeighborhood({ links, focusId: "x", direction: "causes", depth: 2, minPapers: 2 });
  const graph = neighborhoodGraph({ rows, focusId: "x", links, direction: "causes" });
  assert.deepEqual([...graph.groupIds].sort(), ["b", "c", "x"]);
  const byId = new Map(graph.links.map(l => [l.edge_id, l]));
  // Only b → x qualified, so the arrow is one way even though the project link is bidirectional.
  assert.equal(byId.get("b__x").direction_type, "A_TO_B");
  assert.equal(byId.get("c__b").direction_type, "A_TO_B");
  assert.equal(links[0].direction_type, "BIDIRECTIONAL");
  // Links not on a chosen route (x → y goes away from the causes) are not drawn.
  assert.equal(byId.has("x__y"), false);
  // Layout hints name each variable's neighbour toward the focus.
  assert.deepEqual(Object.fromEntries(graph.layout.parent), { b: "x", c: "b" });
  assert.deepEqual(Object.fromEntries(graph.layout.distance), { b: 1, c: 2 });
});

test("consequences narrow the direction the other way round", () => {
  const links = [link("x", "b", "BIDIRECTIONAL", 1, 3), link("b", "c", "A_TO_B", 2)];
  const rows = causalNeighborhood({ links, focusId: "x", direction: "consequences", depth: 2, minPapers: 2 });
  const graph = neighborhoodGraph({ rows, focusId: "x", links, direction: "consequences" });
  const byId = new Map(graph.links.map(l => [l.edge_id, l]));
  // Only b → x had enough papers, so x does not cause b here and b is not a consequence.
  assert.deepEqual([...graph.groupIds], ["x"]);
  assert.equal(byId.size, 0);
  const both = causalNeighborhood({ links, focusId: "x", direction: "consequences", depth: 2, minPapers: 1 });
  const wider = neighborhoodGraph({ rows: both, focusId: "x", links, direction: "consequences" });
  assert.equal(new Map(wider.links.map(l => [l.edge_id, l])).get("x__b").direction_type, "A_TO_B");
  assert.deepEqual(Object.fromEntries(wider.layout.parent), { b: "x", c: "b" });
});
