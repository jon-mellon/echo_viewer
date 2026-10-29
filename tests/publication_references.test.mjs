import test from "node:test";
import assert from "node:assert/strict";
import { publishWorkingSchema, canonicalizeWorkingSchema } from "../site/dag_publication_core.mjs";
import { loadGroupingSchemaFolder } from "../site/grouping_schema_loader.mjs";
import { canonicalFolderHash, stableJson } from "../site/grouping_schema_writer.mjs";

const root = "https://example.test/storage/v1/object/public/published-schemas/";
const schema = groups => ({ schema_version: "groupings-v3", grouping_set_id: "test", label: "Test",
  membership_unit: "canonical_variable", built_against: { record_signature: "snapshot" }, groups });
const group = (group_id, variable_ids) => ({ group_id, label: group_id, variable_ids });

test("publication reuses unchanged memberships, writes changed ones, and reconstructs its canonical hash", async () => {
  const original = schema([group("education", ["a", "b"]), group("health", ["c"])]);
  const changed = schema([group("verbal", ["a"]), group("nonverbal", ["b"]), group("health", ["c"])]);
  const parent = (await canonicalizeWorkingSchema(original)).files;
  const objects = new Map([...parent].map(([p, b]) => [root + "old/" + p, b]));
  const uploads = new Map();
  const fetchImpl = async url => objects.has(String(url)) ? new Response(objects.get(String(url))) : new Response(null, { status: 404 });
  const client = {
    auth: { getSession: async () => ({ data: { session: { access_token: "test", user: { id: "owner" } } } }),
      getUser: async () => ({ data: { user: { id: "owner" } } }) },
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: [] }) }) }) }) }),
      insert: async () => ({ error: null }) }),
    storage: { from: () => ({ getPublicUrl: path => ({ data: { publicUrl: root + path } }),
      upload: async (path, body) => { const bytes = new Uint8Array(await body.arrayBuffer()); uploads.set(path, bytes); objects.set(root + path, bytes); return { error: null }; } }) },
  };
  const result = await publishWorkingSchema({ schema: changed, previousPublication: { publication_id: "old", storage_prefix: "old" }, client, fetchImpl, compileInput: { rawLinks: [] } });
  const prefix = `owner/${result.publicationId}/`;
  const manifest = JSON.parse(new TextDecoder().decode(uploads.get(prefix + "manifest.json")));
  assert.equal(manifest.group_membership_references.health, root + "old/memberships/health.tsv");
  assert.equal(uploads.has(prefix + "memberships/health.tsv"), false);
  assert.ok(uploads.has(prefix + "memberships/verbal.tsv"));
  assert.ok(uploads.has(prefix + "memberships/nonverbal.tsv"));
  const loaded = await loadGroupingSchemaFolder(root + prefix, fetchImpl);
  assert.deepEqual(loaded.groups.find(g => g.group_id === "health").variable_ids, ["c"]);
  const logical = new Map([...uploads].filter(([p]) => p.startsWith(prefix) && !p.includes("compiled/")).map(([p, b]) => [p.slice(prefix.length), b]));
  delete manifest.group_membership_references;
  logical.set("manifest.json", new TextEncoder().encode(stableJson(manifest)));
  logical.set("memberships/health.tsv", objects.get(root + "old/memberships/health.tsv"));
  assert.equal(await canonicalFolderHash(logical), result.contentHash);
});
