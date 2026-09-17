import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import * as search from "../site/dag_search.mjs";

test("neighbor eligibility filters rejected clusters and active UOA before limiting", () => {
  const group = { variable_ids: ["seed"] };
  const neighbors = ["rejected-copy", "country", "person-low", "person-high", "unknown"]
    .map((variable_id, i) => ({ variable_id, llm_rank: i + 1, cosine_similarity: 0.9 }));
  const options = {
    variableById: new Map([
      ["seed", { similarity_neighbors: neighbors }],
      ["rejected-copy", { uoa: "person" }], ["country", { uoa: "country" }],
      ["person-low", { uoa: "person" }], ["person-high", { uoa: "person" }],
      ["unknown", {}],
    ]),
    blockedIds: new Set(["seed"]), rejectedIds: new Set(["rejected-rep"]),
    clusterMemberIds: id => id === "rejected-copy" ? ["rejected-rep", id] : [id],
    selectedUoa: "person", uoaFilterEnabled: true, uoaMatches: (a, b) => a === b,
  };
  const ids = opts => search.groupNeighborSuggestions(group, opts, 2).map(n => n.variable_id);
  assert.deepEqual(ids(options), ["person-low", "person-high"]);
  assert.deepEqual(ids({ ...options, uoaFilterEnabled: false }), ["country", "person-low"]);
  assert.deepEqual(ids({ ...options, selectedUoa: null }), ["country", "person-low"]);
  assert.deepEqual(ids({ ...options, rejectedIds: new Set() }), ["rejected-copy", "person-low"]);
});

test("search and suggestion ordering match pre-extraction behavior without mutating inputs", () => {
  const variables = [
    { variable_id: "a", index: 2, display_label: "Income", uoa: "person", similarity_neighbors: [
      { variable_id: "c", llm_rank: 2, cosine_similarity: 0.9 },
      { variable_id: "b", llm_rank: 1, cosine_similarity: 0.8 },
      { variable_id: "missing", llm_rank: 1 },
      { variable_id: "blocked-copy", llm_rank: 1 },
    ] },
    { variable_id: "b", index: 1, display_label: "Income growth", raw_variable_text: "household earnings", uoa: "person" },
    { variable_id: "c", index: 3, display_label: "Income", uoa: "country" },
    { variable_id: "rejected", index: 0, display_label: "Income", uoa: "person" },
    { variable_id: "blocked-copy", index: 4, display_label: "Income", uoa: "person" },
  ];
  const groups = [
    { group_id: "iv", type: "iv", variable_ids: ["a"] },
    { group_id: "dv", type: "dv", variable_ids: ["blocked"] },
    { group_id: "g", label: "Income group", variable_ids: ["b"] },
    { group_id: "h", label: "Other", variable_ids: ["c"] },
    { group_id: "empty", variable_ids: [] },
  ];
  const state = { variables, variableById: new Map(variables.map(v => [v.variable_id, v])),
    project: { groups, iv_group_id: "iv", dv_group_id: "dv" }, selectedUoa: "person", uoaFilterEnabled: true };
  const visibleVariables = () => variables.filter(v => v.variable_id !== "rejected");
  const blockedIds = new Set(["a", "blocked"]);
  const clusterMemberIds = id => id === "blocked-copy" ? ["blocked", id] : [id];
  const uoaMatches = (a, b) => a === b;
  const legacy = vm.createContext({ state, visibleVariables, uoaMatches, clusterMemberIds,
    groupedVariableIds: () => blockedIds, normalized: v => String(v ?? "").trim().toLowerCase() });
  vm.runInContext(readFileSync(new URL("./fixtures/legacy_dag_search.js", import.meta.url), "utf8"), legacy);
  const plain = value => JSON.parse(JSON.stringify(value));
  const before = structuredClone({ variables, groups });
  for (const enabled of [false, true]) for (const query of ["", " INCOME ", "income growth", "earnings", "missing"]) {
    state.uoaFilterEnabled = enabled;
    for (const limit of [1, 20]) {
      assert.deepEqual(plain(search.searchVariables(query, {
        variables: visibleVariables(), selectedUoa: state.selectedUoa, uoaFilterEnabled: enabled, uoaMatches,
      }, limit)), plain(legacy.searchVariables(query, limit)));
    }
  }
  for (const side of ["iv", "dv"]) for (const query of ["", "income", "earnings", "missing"]) {
    const expected = legacy.availableSetupAnchorGroups(side)
      .map((g, i) => legacy.anchorGroupSearchMatch(g, query, i))
      .filter(r => r.matches)
      .sort((a, b) => Number(b.labelMatches) - Number(a.labelMatches) || a.index - b.index).slice(0, 12);
    assert.deepEqual(plain(search.searchAnchorGroups(state.project, side, query, state.variableById)), plain(expected));
  }
  assert.deepEqual(plain(search.groupNeighborSuggestions(groups[0], {
    variableById: state.variableById, blockedIds, clusterMemberIds,
  }, 14)), plain(legacy.groupNeighborSuggestions(groups[0], 14)));
  assert.deepEqual({ variables, groups }, before);
});

test("group search uses lightweight global records for unhydrated members", () => {
  const project = { groups: [
    { group_id: "education", label: "Education", variable_ids: ["v-degree"], type: null },
    { group_id: "health", label: "Health", variable_ids: ["v-health"], type: null },
  ], iv_group_id: null, dv_group_id: null };
  const variableById = new Map();
  const searchRecordById = new Map([["v-degree", {
    variable_id: "v-degree", display_label: "Education level",
    concept_label: "Educational attainment", raw_variable_text: "college degree completed",
  }]]);
  const results = search.searchAnchorGroups(project, "iv", "college", variableById, 12, searchRecordById);
  assert.deepEqual(results.map(result => result.group.group_id), ["education"]);
  assert.equal(results[0].variableMatch, "college degree completed");
  assert.equal(variableById.size, 0);
});
