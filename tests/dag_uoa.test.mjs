import test from "node:test";
import assert from "node:assert/strict";
import { PERSON_UOA_SENTINEL, projectForUoa, uoaCounts, uoaMatches } from "../site/dag_uoa.mjs";
import { aggregateGroupLinks, linkKey } from "../site/dag_link_aggregation.mjs";

test("UOA matching preserves exact categories and the existing combined person category", () => {
  assert.equal(uoaMatches("country, person", "country"), true);
  assert.equal(uoaMatches("country, person", "firm"), false);
  assert.equal(uoaMatches("eligible voter", PERSON_UOA_SENTINEL), true);
  assert.equal(uoaMatches("country", PERSON_UOA_SENTINEL), false);
  assert.equal(uoaMatches("", "country"), false);
  assert.equal(uoaMatches("", null), true);
});

test("UOA counts split comma-separated values and sort deterministically", () => {
  assert.deepEqual(uoaCounts([
    { uoa: "person, country" }, { uoa: "person" }, { uoa: "firm" },
  ]), [["person", 2], ["country", 1], ["firm", 1]]);
});

test("DAG UOA projection filters group membership without mutating the project", () => {
  const project = {
    iv_group_id: "iv", dv_group_id: "dv",
    groups: [
      { group_id: "iv", label: "Education", variable_ids: ["p1", "c1"] },
      { group_id: "dv", label: "Income", variable_ids: ["p2"] },
      { group_id: "other", label: "GDP", variable_ids: ["c2"] },
    ],
  };
  const variables = new Map([
    ["p1", { uoa: "person" }], ["p2", { uoa: "eligible voter" }],
    ["c1", { uoa: "country" }], ["c2", { uoa: "country" }],
  ]);
  const before = structuredClone(project);
  const filtered = projectForUoa(project, variables, PERSON_UOA_SENTINEL, true);
  assert.deepEqual(filtered.groups.map(group => group.variable_ids), [["p1"], ["p2"], []]);
  assert.deepEqual(project, before);
  assert.strictEqual(projectForUoa(project, variables, null, true), project);
  assert.strictEqual(projectForUoa(project, variables, "country", false), project);
});

test("projected DAG links contain only evidence from the selected UOA", () => {
  const project = {
    iv_group_id: "iv", dv_group_id: "dv", manual_edges: [], link_decisions: {},
    groups: [
      { group_id: "iv", variable_ids: ["person_iv", "country_iv"] },
      { group_id: "dv", variable_ids: ["person_dv", "country_dv"] },
      { group_id: "country_only", variable_ids: ["country_other"] },
    ],
  };
  const variables = new Map([
    ["person_iv", { uoa: "person" }], ["person_dv", { uoa: "person" }],
    ["country_iv", { uoa: "country" }], ["country_dv", { uoa: "country" }],
    ["country_other", { uoa: "country" }],
  ]);
  const linkLookup = new Map([
    [linkKey("person_iv", "person_dv"), ["person_link"]],
    [linkKey("country_iv", "country_dv"), ["country_link"]],
    [linkKey("country_other", "country_dv"), ["other_link"]],
  ]);
  const rawLinksById = new Map([
    ["person_link", {}], ["country_link", {}], ["other_link", {}],
  ]);
  const filteredProject = projectForUoa(project, variables, "person", true);
  const links = aggregateGroupLinks({ project: filteredProject, linkLookup, rawLinksById });
  assert.equal(filteredProject.groups.find(group => group.group_id === "country_only").variable_ids.length, 0);
  assert.deepEqual(links.flatMap(link => link.a_to_b_raw_link_ids), ["person_link"]);
  assert.equal(links.some(link => link.group_a === "country_only" || link.group_b === "country_only"), false);
});
