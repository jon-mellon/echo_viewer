import test from "node:test";
import assert from "node:assert/strict";
import { browsePublishedSplits, loadPublishedSplitMembership } from "../site/published_split_browser.mjs";
import { writeGroupingSchemaFolder } from "../site/grouping_schema_writer.mjs";
import { GROUPING_FORMAT_VERSION, GROUPING_MEMBERSHIP_UNIT } from "../site/app_contracts.mjs";

test("browse keeps approved splits, including the viewer's own, matching the exact selected sources", async () => {
  const rows = [
    { publication_id: "one", group_id: "g1", split_id: "split-1", owner_id: "other",
      source_group_ids: ["a"], published_at: "2026-10-01" },
    { publication_id: "later", group_id: "g1", split_id: "split-1", owner_id: "other",
      source_group_ids: ["a"], published_at: "2026-10-03" },
    { publication_id: "mine", group_id: "own", split_id: "own", owner_id: "me",
      source_group_ids: ["a"], published_at: "2026-10-04" },
    { publication_id: "two", group_id: "g2", split_id: "split-2", owner_id: "other",
      source_group_ids: ["a", "b"], published_at: "2026-10-02" },
  ];
  const client = { auth: { getSession: async () => ({ data: { session: { user: { id: "me" } } } }) }, from: () => ({
    select() { return this; }, eq() { return this; }, contains(_column, [id]) { this.id = id; return this; },
    order() { return this; }, async limit() { return { data: rows.filter(row => row.source_group_ids.includes(this.id)), error: null }; },
  }) };
  assert.deepEqual((await browsePublishedSplits(["a"], client)).map(row => row.group_id), ["own", "g1"]);
  assert.deepEqual((await browsePublishedSplits(["a"], client)).map(row => row.publication_id), ["mine", "later"]);
  assert.deepEqual((await browsePublishedSplits(["a", "b"], client)).map(row => row.group_id), ["g2"]);
});

test("loading a split fetches its membership file and rejects a changed pointer", async () => {
  const group = { group_id: "new", label: "School outcomes",
    description: "Outcomes measured in formal education.", source: "user_split",
    provenance: { operation: "split_categories", source_group_ids: ["source"] },
    variable_ids: ["v1", "v2"] };
  const files = await writeGroupingSchemaFolder({ schema_version: GROUPING_FORMAT_VERSION,
    membership_unit: GROUPING_MEMBERSHIP_UNIT, grouping_set_id: "test", label: "Test", groups: [group] });
  const fetched = [];
  const fetchImpl = async url => {
    const path = new URL(url).pathname.split("/published/owner/pub/")[1];
    fetched.push(path);
    return new Response(files.get(path), { status: files.has(path) ? 200 : 404 });
  };
  const client = { storage: { from: () => ({ getPublicUrl: path => ({ data: { publicUrl: `https://example.test/published/${path}` } }) }) } };
  const row = { storage_prefix: "owner/pub", group_id: "new", name: group.label,
    description: group.description, membership_path: "memberships/new.tsv" };
  assert.deepEqual(await loadPublishedSplitMembership(row, client, fetchImpl), ["v1", "v2"]);
  assert.deepEqual(fetched, ["manifest.json", "schema.yaml", "groups.tsv", "memberships/new.tsv"]);
  await assert.rejects(loadPublishedSplitMembership({ ...row, membership_path: "memberships/other.tsv" }, client, fetchImpl),
    /pointer no longer matches/);
});
