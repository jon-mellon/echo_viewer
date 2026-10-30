import assert from "node:assert/strict";
import test from "node:test";
import { causalNeighborhood, directedHops, directionalPaperCounter } from "../site/causal_neighborhood.mjs";

const keys = n => Array.from({ length: n }, (_, i) => `p${i}`);
const link = (a, b, direction, forward = 0, backward = 0, extra = {}) => ({
  edge_id: `${a}__${b}`, group_a: a, group_b: b, direction_type: direction,
  a_to_b_paper_table_keys: keys(forward), b_to_a_paper_table_keys: keys(backward),
  display_status: "active_by_default", ...extra,
});

// a → x (3), b → x (2), c → a (5), c → b (1), x → y (4), y → z (2), x ↔ w (2 / 2)
const links = [
  link("a", "x", "A_TO_B", 3),
  link("b", "x", "A_TO_B", 2),
  link("a", "c", "B_TO_A", 0, 5),
  link("b", "c", "B_TO_A", 0, 1),
  link("x", "y", "A_TO_B", 4),
  link("y", "z", "A_TO_B", 2),
  link("w", "x", "BIDIRECTIONAL", 2, 2),
];

test("direct causes and consequences follow link direction and paper support", () => {
  const causes = causalNeighborhood({ links, focusId: "x", direction: "causes", depth: 1, minPapers: 2 });
  assert.deepEqual(causes.map(r => [r.groupId, r.distance, r.papers]), [["a", 1, 3], ["b", 1, 2], ["w", 1, 2]]);
  const effects = causalNeighborhood({ links, focusId: "x", direction: "consequences", depth: 1, minPapers: 2 });
  assert.deepEqual(effects.map(r => [r.groupId, r.papers]), [["y", 4], ["w", 2]]);
  assert.deepEqual(effects[0].path, ["x", "y"]);
});

test("greater depth adds indirect variables with their best-supported shortest path", () => {
  const causes = causalNeighborhood({ links, focusId: "x", direction: "causes", depth: 2, minPapers: 1 });
  const c = causes.find(r => r.groupId === "c");
  assert.equal(c.distance, 2);
  // c → a → x (weakest 3) beats c → b → x (weakest 1).
  assert.deepEqual(c.path, ["c", "a", "x"]);
  assert.equal(c.weakestPapers, 3);
  const effects = causalNeighborhood({ links, focusId: "x", direction: "consequences", depth: 2, minPapers: 1 });
  assert.deepEqual(effects.find(r => r.groupId === "z").path, ["x", "y", "z"]);
});

test("minimum papers removes weak hops and anything only reachable through them", () => {
  const causes = causalNeighborhood({ links, focusId: "x", direction: "causes", depth: 3, minPapers: 3 });
  assert.deepEqual(causes.map(r => r.groupId), ["a", "c"]);
});

test("excluded links, self links and a missing focus contribute nothing", () => {
  const withExcluded = [...links, link("q", "x", "A_TO_B", 9, 0, { display_status: "excluded" }), link("x", "x", "A_TO_B", 9)];
  const causes = causalNeighborhood({ links: withExcluded, focusId: "x", direction: "causes", depth: 1, minPapers: 1 });
  assert.equal(causes.some(r => r.groupId === "q" || r.groupId === "x"), false);
  assert.deepEqual(causalNeighborhood({ links, focusId: "", direction: "causes" }), []);
  assert.equal(directedHops([link("a", "b", "BIDIRECTIONAL", 2, 1)], 2).length, 1);
});

test("support records count distinct papers with present findings in each direction", () => {
  const support = new Map([
    ["r1", { paper_id: "P1", causal_link_existence: "present" }],
    ["r2", { paper_id: "P1", causal_link_existence: "present" }],
    ["r3", { paper_id: "P2", causal_link_existence: "absent" }],
    ["r4", { paper_id: "P3", causal_link_existence: "present" }],
  ]);
  const edge = { ...link("a", "b", "BIDIRECTIONAL"), a_to_b_raw_link_ids: ["r1", "r2", "r3"], b_to_a_raw_link_ids: ["r4"],
    a_to_b_paper_table_keys: ["P1::t1", "P1::t2", "P2::t1"] };
  const counted = directionalPaperCounter(support);
  // Two tables from one paper count once; the null finding does not count.
  assert.equal(counted(edge, true), 1);
  assert.equal(counted(edge, false), 1);
  // Without support records, paper IDs from the compiled keys are the fallback.
  assert.equal(directionalPaperCounter()(edge, true), 2);
  // The IV-DV relation stays traversable even when excluded, as in the diagrams.
  const target = link("a", "b", "A_TO_B", 3, 0, { display_status: "excluded", is_target_relation: true });
  assert.equal(directedHops([target], 1).length, 1);
});
