import test from "node:test";
import assert from "node:assert/strict";
import { publishWorkingSchema, canonicalizeWorkingSchema } from "../site/dag_publication_core.mjs";

test("local and browser publication share the same immutable file and registry operation", async () => {
  const schema = { schema_version: "groupings-v3", grouping_set_id: "test", label: "Test",
    description: "Fixture", membership_unit: "canonical_variable",
    built_against: { record_signature: "snapshot" },
    groups: [{ group_id: "iv", label: "IV", variable_ids: ["i"] },
      { group_id: "dv", label: "DV", variable_ids: ["d"] }],
    link_decisions: { iv__dv: { display_status: "excluded", exclude_reason: "private" } } };
  const calls = [];
  const owner = { id: "owner" };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { access_token: "test", user: owner } }, error: null }),
      getUser: async () => ({ data: { user: owner }, error: null }),
    },
    from(name) {
      assert.equal(name, "published_schemas");
      return {
        select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({
          limit: async () => ({ data: [], error: null }),
        }) }) }) }),
        insert: async row => { calls.push(["insert", row]); return { error: null }; },
      };
    },
    storage: { from(bucket) {
      assert.equal(bucket, "published-schemas");
      return { upload: async (path, body) => {
        calls.push(["upload", path, await body.text()]);
        return { error: null };
      } };
    } },
  };
  const result = await publishWorkingSchema({ schema, client,
    previousPublication: { publication_id: "parent" }, compileInput: { rawLinks: [] } });
  assert.equal(result.contentHash, (await canonicalizeWorkingSchema(schema)).contentHash);
  assert.equal(calls.at(-1)[0], "insert");
  assert.equal(calls.at(-1)[1].parent_schema_id, "parent");
  assert.ok(calls.some(([kind, path]) => kind === "upload" && path.endsWith("compiled/dag.json")));
  assert.ok(calls.some(([kind, path]) => kind === "upload" && path.endsWith("manifest.json")));
  assert.ok(calls.every(([kind]) => kind === "upload" || kind === "insert"));
  assert.ok(calls.filter(([kind]) => kind === "upload").every(([, , text]) => !text.includes("private")));
});
