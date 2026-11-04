import test from "node:test";
import assert from "node:assert/strict";
import { publishWorkingSchema, canonicalizeWorkingSchema } from "../site/dag_publication_core.mjs";
import { fakePublishService } from "./support/fake_publish_service.mjs";

test("local and browser publication share the Cloudflare immutable file operation", async () => {
  const schema = { schema_version: "groupings-v3", grouping_set_id: "test", label: "Test",
    description: "Fixture", membership_unit: "canonical_variable",
    built_against: { record_signature: "snapshot" },
    groups: [{ group_id: "iv", label: "IV", variable_ids: ["i"] },
      { group_id: "dv", label: "DV", variable_ids: ["d"] }],
    link_decisions: { iv__dv: { display_status: "excluded", exclude_reason: "private" } } };
  const service = fakePublishService();
  const saved = new Map();
  const cloudflare = { apiUrl: "https://api.test", fetchImpl: service.fetchImpl,
    storage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    solve: async () => "good-token" };
  const result = await publishWorkingSchema({ schema, cloudflare,
    previousPublication: { publication_id: "parent" }, compileInput: { rawLinks: [] } });
  assert.equal(result.contentHash, (await canonicalizeWorkingSchema(schema)).contentHash);
  assert.equal(result.parent_schema_id, "parent");
  assert.equal(service.rows.size, 1);
  const paths = [...service.objects.keys()];
  assert.ok(paths.some(path => path.endsWith("compiled/dag.json")));
  assert.ok(paths.some(path => path.endsWith("manifest.json")));
  for (const { bytes } of service.objects.values()) {
    assert.ok(!new TextDecoder().decode(bytes).includes("private"));
  }
});
