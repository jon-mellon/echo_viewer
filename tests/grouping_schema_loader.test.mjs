import assert from "node:assert/strict";
import test from "node:test";

import { loadGroupingSchemaFolder } from "../site/grouping_schema_loader.mjs";

test("folder loader reconstructs the normalized grouping schema from manifest-listed files", async () => {
  const files = new Map([
    ["manifest.json", JSON.stringify({ format_version: "groupings-v2", schema_file: "schema.yaml",
      group_files: ["groups/g_age.yaml"], membership_shards: ["memberships/0000.tsv"],
      rejected_file: "rejected.tsv", membership_unit: "canonical_variable",
      compatibility: { fingerprint_version: "v", record_signature: "sig", source_dir: "source", n_variables: 1 },
      extra: { hidden_variable_ids: ["hidden"] } })],
    ["schema.yaml", 'schema_version: "groupings-v2"\ngrouping_set_id: "set"\nlabel: "Example"\n'],
    ["groups/g_age.yaml", 'group_id: "g_age"\nlabel: "Age"\nnotes: ""\n'],
    ["memberships/0000.tsv", "variable_id\tgroup_id\nv000014\tg_age\n"],
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

test("folder loader rejects memberships that reference an unlisted group", async () => {
  const files = { "manifest.json": JSON.stringify({ format_version: "groupings-v2", schema_file: "schema.yaml",
    group_files: [], membership_shards: ["memberships/0000.tsv"] }),
  "schema.yaml": 'grouping_set_id: "set"\n', "memberships/0000.tsv": "variable_id\tgroup_id\nv1\tmissing\n" };
  const fetchImpl = async (url) => ({ ok: true, status: 200, text: async () => files[new URL(url).pathname.split("/schema/")[1]] });
  await assert.rejects(() => loadGroupingSchemaFolder("http://localhost:8000/schema/", fetchImpl), /unknown group/);
});
