import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { canonicalFolderHash, writeGroupingSchemaFolder } from "../site/grouping_schema_writer.mjs";

const schema = {
  schema_version: "groupings-v2",
  grouping_set_id: "stable-schema",
  label: "Stable schema",
  description: "Fixture",
  cache_compatibility: { record_signature: "abc", n_variables: 3 },
  built_against: { record_signature: "abc", n_variables: 3 },
  membership_unit: "canonical_variable",
  groups: [
    { group_id: "z", label: "Zulu", notes: "", source: "project_export", variable_ids: ["v001001"] },
    { group_id: "a", label: "Alpha", notes: "Note", source: "manual_review", variable_ids: ["v000002", "v000001"] },
  ],
  rejected_variables: [{
    variable_id: "v000003", member_variable_ids: ["v000003"], label: "Rejected",
    reason: "low_quality", flagged_at: "", previous_group_ids: ["z", "a"],
  }],
  hidden_variable_ids: ["v000003"],
};

test("folder writer is byte-stable across semantic collection ordering", async () => {
  const first = await writeGroupingSchemaFolder(schema, webcrypto);
  const reordered = structuredClone(schema);
  reordered.groups.reverse();
  reordered.groups[1].variable_ids.reverse();
  reordered.rejected_variables[0].previous_group_ids.reverse();
  const second = await writeGroupingSchemaFolder(reordered, webcrypto);
  assert.deepEqual([...first], [...second]);
  assert.equal(await canonicalFolderHash(first, webcrypto), await canonicalFolderHash(second, webcrypto));
});

test("folder manifest lists every reconstruction artifact and emits normalized TSV", async () => {
  const files = await writeGroupingSchemaFolder(schema, webcrypto);
  const decode = path => new TextDecoder().decode(files.get(path));
  const manifest = JSON.parse(decode("manifest.json"));
  assert.equal(manifest.format_version, "groupings-v2");
  assert.deepEqual(manifest.group_files, ["groups/a.yaml", "groups/z.yaml"]);
  assert.deepEqual(manifest.membership_shards, ["memberships/0000.tsv", "memberships/0001.tsv"]);
  assert.equal(manifest.rejected_file, "rejected.tsv");
  assert.equal(decode("memberships/0000.tsv"), "variable_id\tgroup_id\nv000001\ta\nv000002\ta\n");
  assert.ok([...files.values()].every(bytes => new TextDecoder().decode(bytes).endsWith("\n")));
});

test("folder writer rejects conflicting canonical memberships", async () => {
  const invalid = structuredClone(schema);
  invalid.groups[1].variable_ids.push("v001001");
  await assert.rejects(() => writeGroupingSchemaFolder(invalid, webcrypto), /conflicting group ownership/);
});
