import test from "node:test";
import assert from "node:assert/strict";
import { dagTableModel, linkPapers, sortedLinkRows } from "../site/dag_table.mjs";

const groups = [
  { group_id: "a", label: "Alpha", variable_ids: ["1", "2"] },
  { group_id: "b", label: "Beta", member_count: 5 },
  { group_id: "c", label: "Gamma", variable_ids: [] },
];
const links = [
  { edge_id: "ab", group_a: "a", group_b: "b", direction_type: "A_TO_B",
    a_to_b_paper_table_keys: ["p1::t1", "p1::t2", "p2::t1"], b_to_a_paper_table_keys: ["p9::t1"] },
  { edge_id: "ba", group_a: "a", group_b: "c", direction_type: "B_TO_A",
    a_to_b_paper_table_keys: [], b_to_a_paper_table_keys: ["p3::t1"] },
  { edge_id: "ac", group_a: "b", group_b: "c", direction_type: "BIDIRECTIONAL",
    a_to_b_paper_table_keys: ["p1::x"], b_to_a_paper_table_keys: ["p1::y", "p4::z"] },
  { edge_id: "stale", group_a: "a", group_b: "c", direction_type: "A_TO_B" },
];

test("papers count only the papers behind the direction a link points", () => {
  assert.equal(linkPapers(links[0]), 2);
  assert.equal(linkPapers(links[1]), 1);
  assert.equal(linkPapers(links[2]), 2);
  assert.equal(linkPapers(links[3]), null);
});

test("the table lists every variable and link the graph draws, source first", () => {
  const model = dagTableModel({ groups, links, roleFor: group => group.group_id === "a" ? "Ind var" : "" });
  assert.equal(model.variableRows.length, 3);
  assert.equal(model.linkRows.length, 4);
  const reversed = model.linkRows.find(row => row.edgeId === "ba");
  assert.deepEqual([reversed.source, reversed.target, reversed.direction], ["Gamma", "Alpha", "Causes"]);
  assert.equal(model.linkRows.find(row => row.edgeId === "ac").direction, "Both directions");
  const alpha = model.variableRows.find(row => row.groupId === "a");
  assert.deepEqual([alpha.role, alpha.variables, alpha.links], ["Ind var", 2, 3]);
  assert.equal(model.variableRows.find(row => row.groupId === "b").variables, 5);
});

test("study relationships are listed first and are not evidence links", () => {
  const model = dagTableModel({ groups, links, studyLinks: [
    { edgeId: "__study", sourceId: "a", targetId: "b", note: "Study relationship" },
    { edgeId: "__gone", sourceId: "a", targetId: "missing", note: "Study relationship" }] });
  assert.equal(model.linkRows.length, 5);
  const rows = sortedLinkRows(model.linkRows, "papers");
  assert.equal(rows[0].edgeId, "__study");
  assert.equal(rows[0].kind, "study");
  assert.equal(model.variableRows.find(row => row.groupId === "a").links, 3);
});

test("links sort by papers with unknown counts last", () => {
  const rows = sortedLinkRows(dagTableModel({ groups, links }).linkRows, "papers");
  assert.deepEqual(rows.map(row => row.edgeId), ["ab", "ac", "ba", "stale"]);
});
