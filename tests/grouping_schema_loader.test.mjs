import assert from "node:assert/strict";
import test from "node:test";

import { loadGroupingSchemaFolder, loadGroupingSchemaStructure } from "../site/grouping_schema_loader.mjs";

test("folder loader reconstructs the normalized grouping schema from manifest-listed files", async () => {
  const files = new Map([
    ["manifest.json", JSON.stringify({ format_version: "groupings-v3", schema_file: "schema.yaml",
      groups_file: "groups.tsv", group_membership_files: { g_age: "memberships/g_age.tsv" },
      rejected_file: "rejected.tsv", membership_unit: "canonical_variable",
      compatibility: { fingerprint_version: "v", record_signature: "sig", source_dir: "source", n_variables: 1 },
      extra: { hidden_variable_ids: ["hidden"] } })],
    ["schema.yaml", 'schema_version: "groupings-v3"\ngrouping_set_id: "set"\nlabel: "Example"\n'],
    ["groups.tsv", 'group_id\tmetadata\ng_age\t"{\n""label"": ""Age"",\n""notes"": """"\n}"\n'],
    ["memberships/g_age.tsv", "variable_id\nv000014\n"],
    ["rejected.tsv", 'variable_id\tmember_variable_ids\tlabel\treason\tflagged_at\tprevious_group_ids\nv000732\t"[""v000732""]"\tBad\tlow_quality\t2026-01-01\t[]\n'],
  ]);
  const requested = [];
  const fetchImpl = async (url) => {
    const name = new URL(url).pathname.split("/schema/")[1];
    requested.push(name);
    return { ok: files.has(name), status: files.has(name) ? 200 : 404,
      text: async () => files.get(name), json: async () => JSON.parse(files.get(name)) };
  };
  const result = await loadGroupingSchemaFolder("https://raw.githubusercontent.com/org/repo/main/schema/", fetchImpl);
  assert.equal(result.grouping_set_id, "set");
  assert.deepEqual(result.groups[0].variable_ids, ["v000014"]);
  assert.deepEqual(result.rejected_variables[0].member_variable_ids, ["v000732"]);
  assert.deepEqual(result.hidden_variable_ids, ["hidden"]);
  assert.deepEqual(new Set(requested), new Set(files.keys()));
});

test("folder loader rejects a membership map that references an unlisted group", async () => {
  const files = { "manifest.json": JSON.stringify({ format_version: "groupings-v3", schema_file: "schema.yaml",
    groups_file: "groups.tsv", group_membership_files: { missing: "memberships/missing.tsv" } }),
  "schema.yaml": 'grouping_set_id: "set"\n', "groups.tsv": "group_id\tmetadata\n",
  "memberships/missing.tsv": "variable_id\nv1\n" };
  const fetchImpl = async (url) => ({ ok: true, status: 200, text: async () => files[new URL(url).pathname.split("/schema/")[1]] });
  await assert.rejects(() => loadGroupingSchemaFolder("http://localhost:8000/schema/", fetchImpl), /does not match groups.tsv/);
});

test("staged loader fetches selected group memberships before the remainder", async () => {
  const files = new Map([
    ["manifest.json", JSON.stringify({ format_version: "groupings-v3", schema_file: "schema.yaml",
      groups_file: "groups.tsv", group_membership_files: {
        first: "memberships/first.tsv", second: "memberships/second.tsv" },
      membership_unit: "canonical_variable" })],
    ["schema.yaml", 'schema_version: "groupings-v3"\ngrouping_set_id: "set"\n'],
    ["groups.tsv", 'group_id\tmetadata\nfirst\t"{\n""label"": ""First""\n}"\nsecond\t"{\n""label"": ""Second""\n}"\n'],
    ["memberships/first.tsv", "variable_id\nv1\n"],
    ["memberships/second.tsv", "variable_id\nv2\n"],
  ]);
  const requested = [];
  const fetchImpl = async url => {
    const name = new URL(url).pathname.slice(1);
    requested.push(name);
    return { ok: files.has(name), status: files.has(name) ? 200 : 404, text: async () => files.get(name) };
  };
  const staged = await loadGroupingSchemaStructure("http://local/", fetchImpl);
  await staged.loadMemberships(["second"]);
  assert.deepEqual(staged.schema.groups.find(group => group.group_id === "second").variable_ids, ["v2"]);
  assert.equal(requested.includes("memberships/first.tsv"), false);
  await staged.loadComplete();
  assert.ok(requested.indexOf("memberships/second.tsv") < requested.indexOf("memberships/first.tsv"));
});
