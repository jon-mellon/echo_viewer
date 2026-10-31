import test from "node:test";
import assert from "node:assert/strict";
import { dagTableModel, enumeratePaths, linkPapers, pathView, sortedPathRows } from "../site/dag_table.mjs";

const groups = ["iv", "dv", "c1", "c2", "m"].map(id => ({ group_id: id, label: id.toUpperCase(), variable_ids: id === "m" ? [] : ["1", "2"] }));
const link = (edge_id, group_a, group_b, direction_type = "A_TO_B", extra = {}) => ({ edge_id, group_a, group_b, direction_type, ...extra });
const links = [
  link("c1-iv", "c1", "iv", "A_TO_B", { a_to_b_paper_table_keys: ["p1::t1", "p1::t2", "p2::t1"], b_to_a_paper_table_keys: ["p9::t1"] }),
  link("c1-dv", "dv", "c1", "B_TO_A", { a_to_b_paper_table_keys: [], b_to_a_paper_table_keys: ["p3::t1"] }),
  link("c2-m", "c2", "m"), link("m-iv", "m", "iv", "BIDIRECTIONAL"), link("c2-dv", "c2", "dv"),
];

test("papers count only the papers behind the direction a link points", () => {
  assert.equal(linkPapers(links[0]), 2);
  assert.equal(linkPapers(links[1]), 1);
  assert.equal(linkPapers(links[2]), null);
});

test("the table follows the diagnostic the graph shows, with the graph's precedence", () => {
  assert.equal(pathView({ exploring: true, showExogeneity: true }), "explore");
  assert.equal(pathView({ showExogeneity: true, showCollidersOnly: true }), "exogeneity");
  assert.equal(pathView({ showExclusionViolations: true, showConfoundersOnly: true }), "exclusion");
  assert.equal(pathView({ showCollidersOnly: true, showConfoundersOnly: true }), "colliders");
  assert.equal(pathView({ showConfoundersOnly: true }), "confounders");
  assert.equal(pathView({}), "links");
});

const anchors = { ivId: "iv", dvId: "dv" };
const ids = chain => chain.nodes.map(node => node.id);

test("each confounder is one row with its paths to the Ind var and to the Dep var, one link per arrow", () => {
  const pathsByGroup = new Map([
    ["c2", { toIv: ["c2", "m", "iv"], toDv: ["c2", "dv"] }],
    ["c1", { toIv: ["c1", "iv"], toDv: ["c1", "dv"] }],
    ["gone", { toIv: ["gone", "iv"], toDv: ["gone", "dv"] }],
  ]);
  const model = dagTableModel({ view: "confounders", groups, links, pathsByGroup, anchors, maxPathLength: 2 });
  assert.deepEqual(model.headers, ["Path to Ind var", "Path to Dep var"]);
  assert.equal(model.candidateHeader, "Confounder");
  assert.deepEqual(model.rows.map(row => row.id), ["c1", "c2"], "candidates are listed by name; groups that are not drawn are left out");
  const [c1, c2] = model.rows;
  assert.deepEqual(c1.lines[0].map(ids), [["c1", "iv"], ["c1", "dv"]]);
  assert.deepEqual(c1.lines[0].map(chain => chain.edgeIds), [["c1-iv"], ["c1-dv"]], "the link is found whichever way it is stored");
  assert.deepEqual(c2.lines[0][0].edgeIds, ["c2-m", "m-iv"]);
  assert.equal(model.hasPaperColumn, false);
});

test("all of a confounder's paths are listed together, its own witness path first", () => {
  const more = [...links, link("c2-iv", "c2", "iv"), link("c2-m2", "c2", "m2"), link("m2-dv", "m2", "dv"),
    link("dv-c2-back", "dv", "c2")];
  const withM2 = [...groups, { group_id: "m2", label: "M2", variable_ids: ["1"] }];
  const model = dagTableModel({ view: "confounders", groups: withM2, links: more, anchors, maxPathLength: 2,
    pathsByGroup: new Map([["c2", { toIv: ["c2", "m", "iv"], toDv: ["c2", "dv"] }]]) });
  assert.equal(model.rows.length, 1, "one row, however many paths");
  const [row] = model.rows;
  assert.deepEqual(row.lines.map(line => line[0].nodes.map(node => node.id).join(">")), ["c2>m>iv", "c2>iv"],
    "its witness path to the Ind var, then the direct one");
  assert.deepEqual(row.lines.map(line => line[1].nodes.map(node => node.id).join(">") || "-"), ["c2>dv", "c2>m2>dv"],
    "the Dep var side lists the witness path then the alternative, never passing through the Ind var");
  assert.equal(model.pathCount, 2);
  // Paths through the other anchor are not alternatives, and a shorter limit drops longer paths.
  const short = dagTableModel({ view: "confounders", groups: withM2, links: more, anchors, maxPathLength: 1,
    pathsByGroup: new Map([["c2", { toIv: ["c2", "m", "iv"], toDv: ["c2", "dv"] }]]) });
  assert.deepEqual(short.rows[0].lines.map(line => line[0].nodes.map(node => node.id).join(">")), ["c2>m>iv", "c2>iv"],
    "the witness path always stays; extra paths obey the limit");
  assert.deepEqual(short.rows[0].lines.map(line => line[1].nodes.map(node => node.id).join(">") || "-"), ["c2>dv", "-"]);
});

test("paths are enumerated shortest first, avoid blocked variables and never repeat one", () => {
  const out = new Map([["a", new Set(["b", "x", "t"])], ["b", new Set(["t", "a"])], ["x", new Set(["t"])]]);
  assert.deepEqual(enumeratePaths(out, "a", "t", { maxLength: 2 }), [["a", "t"], ["a", "b", "t"], ["a", "x", "t"]]);
  assert.deepEqual(enumeratePaths(out, "a", "t", { maxLength: 2, blocked: ["b"] }), [["a", "t"], ["a", "x", "t"]]);
  assert.deepEqual(enumeratePaths(out, "a", "t", { maxLength: 1 }), [["a", "t"]]);
  assert.equal(enumeratePaths(out, "a", "t", { maxLength: 2, cap: 2 }).length, 2);
});

test("collider and exogeneity rows use their own columns and path fields", () => {
  const colliders = dagTableModel({ view: "colliders", groups, links, anchors, maxPathLength: 1, pathsByGroup: new Map([
    ["c1", { fromIv: ["iv", "c1"], fromDv: ["dv", "c1"] }]]) });
  assert.deepEqual(colliders.headers, ["Path from Ind var", "Path from Dep var"]);
  assert.equal(colliders.candidateHeader, "Collider");
  assert.deepEqual(colliders.rows[0].lines[0].map(ids), [["iv", "c1"], ["dv", "c1"]]);
  const exogeneity = dagTableModel({ view: "exogeneity", groups, links, anchors: { ...anchors, instrumentId: "m" }, pathsByGroup: new Map([
    ["c2", { toIv: ["c2", "m"], toDv: ["c2", "dv"] }]]) });
  assert.deepEqual(exogeneity.headers, ["Path to Instrument", "Path to Dep var"]);
  const exclusion = dagTableModel({ view: "exclusion", groups, links, anchors, pathsByGroup: new Map([["iv", ["iv", "m", "c2", "dv"]]]) });
  assert.deepEqual(exclusion.rows[0].lines[0][0].edgeIds, ["m-iv", "c2-m", "c2-dv"]);
});

test("causes and consequences rows are the neighborhood's paths, in its order, with their links", () => {
  const exploreRows = [
    { groupId: "c1", path: ["c1", "dv"], pathEdgeIds: ["c1-dv"], weakestPapers: 1 },
    { groupId: "c2", path: ["c2", "m", "dv"], pathEdgeIds: ["c2-m", "m-dv"], weakestPapers: 7 },
  ];
  const model = dagTableModel({ view: "explore", groups, links, exploreRows });
  assert.deepEqual(model.headers, ["Path"]);
  assert.equal(model.hasPaperColumn, true);
  assert.deepEqual(model.rows.map(row => row.id), ["c1", "c2"]);
  assert.deepEqual(model.rows[1].lines[0][0].edgeIds, ["c2-m", "m-dv"]);
  assert.deepEqual(sortedPathRows(model.rows, true).map(row => row.id), ["c2", "c1"]);
});

test("without a diagnostic each link is a row, source first, and bidirectional links are marked", () => {
  const model = dagTableModel({ view: "links", groups, links });
  assert.equal(model.rows.length, 5);
  assert.deepEqual(model.rows.find(row => row.id === "c1-dv").lines[0][0].nodes.map(node => node.id), ["c1", "dv"]);
  assert.equal(model.rows.find(row => row.id === "c1-iv").papers, 2);
});

test("study relationships and variables are listed with the paths", () => {
  const model = dagTableModel({ view: "links", groups, links, roleFor: group => group.group_id === "iv" ? "Ind var" : "",
    studyLinks: [{ edgeId: "__study", sourceId: "iv", targetId: "dv", note: "Study relationship" },
      { edgeId: "__gone", sourceId: "iv", targetId: "missing", note: "x" }] });
  assert.equal(model.study.length, 1);
  assert.deepEqual(model.study[0].chains[0].edgeIds, ["__study"]);
  const iv = model.variableRows.find(row => row.groupId === "iv");
  assert.deepEqual([iv.role, iv.variables, iv.links], ["Ind var", 2, 2]);
  assert.equal(model.variableRows.find(row => row.groupId === "m").variables, 0);
});

test("links the view draws that no path uses are listed after the paths", () => {
  const model = dagTableModel({ view: "confounders", groups, links, anchors, maxPathLength: 1,
    pathsByGroup: new Map([["c1", { toIv: ["c1", "iv"], toDv: ["c1", "dv"] }]]) });
  assert.deepEqual(model.otherLinks.map(row => row.id).sort(), ["c2-dv", "c2-m", "m-iv"]);
  assert.deepEqual(model.otherLinks.find(row => row.id === "c2-m").chains[0].nodes.map(node => node.id), ["c2", "m"]);
  assert.equal(model.otherLinks.some(row => row.id === "c1-dv" || row.id === "c1-iv"), false, "links on a listed path are not repeated");
});

test("a path's own links, and every link when links are the rows, are not listed twice", () => {
  const all = dagTableModel({ view: "links", groups, links });
  assert.deepEqual(all.otherLinks, []);
  const explore = dagTableModel({ view: "explore", groups, links, exploreRows: [
    { groupId: "c1", path: ["c1", "dv"], pathEdgeIds: ["c1-dv"], weakestPapers: 1 }] });
  assert.equal(explore.otherLinks.some(row => row.id === "c1-dv"), false);
});
