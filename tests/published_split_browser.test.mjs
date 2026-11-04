import test from "node:test";
import assert from "node:assert/strict";
import { browsePublishedSplits, loadPublishedSplitMembership } from "../site/published_split_browser.mjs";
import { writeGroupingSchemaFolder } from "../site/grouping_schema_writer.mjs";
import { GROUPING_FORMAT_VERSION, GROUPING_MEMBERSHIP_UNIT } from "../site/app_contracts.mjs";

test("Cloudflare browse finds the current owner's finished split without a public lookup", async () => {
  const ownerId = "00000000-0000-4000-8000-000000000001";
  const token = `${ownerId}.${"a".repeat(64)}`;
  const group = { group_id: "populist-voting", label: "Populist voting",
    description: "Voting for parties with populist political platforms.", source: "user_split",
    provenance: { operation: "split_categories", split_id: "split-populist",
      source_group_ids: ["category-vote"] }, variable_ids: ["v1"] };
  const files = await writeGroupingSchemaFolder({ schema_version: GROUPING_FORMAT_VERSION,
    membership_unit: GROUPING_MEMBERSHIP_UNIT, grouping_set_id: "test", label: "Test", groups: [group] });
  const publication = { id: "00000000-0000-4000-8000-000000000002", owner_id: ownerId,
    storage_prefix: `${ownerId}/00000000-0000-4000-8000-000000000002`, created_at: "2026-11-05T00:00:00Z" };
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    seen.push(path);
    if (path === "/v1/owners/publications") {
      assert.equal(init.headers["x-owner-token"], token);
      return Response.json([publication]);
    }
    const name = path.split(`/${publication.storage_prefix}/`)[1];
    return new Response(files.get(name), { status: files.has(name) ? 200 : 404 });
  };
  const options = { source: "cloudflare", apiUrl: "https://api.test", fetchImpl,
    storage: { getItem: () => token } };
  const rows = await browsePublishedSplits(["category-vote"], null, options);
  assert.deepEqual(rows.map(row => row.name), ["Populist voting"]);
  assert.equal(rows[0].is_own, true);
  assert.deepEqual(await loadPublishedSplitMembership(rows[0], null, fetchImpl, "cloudflare"), ["v1"]);
  assert.ok(seen.includes("/v1/owners/publications"));
  assert.ok(!seen.includes("/v1/splits"));
  assert.deepEqual(await browsePublishedSplits(["another-source"], null, options), []);
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
    const path = new URL(url).pathname.split("/published-schemas/owner/pub/")[1];
    fetched.push(path);
    return new Response(files.get(path), { status: files.has(path) ? 200 : 404 });
  };
  const row = { storage_prefix: "owner/pub", group_id: "new", name: group.label,
    description: group.description, membership_path: "memberships/new.tsv" };
  assert.deepEqual(await loadPublishedSplitMembership(row, null, fetchImpl), ["v1", "v2"]);
  assert.deepEqual(fetched, ["manifest.json", "schema.yaml", "groups.tsv", "memberships/new.tsv"]);
  await assert.rejects(loadPublishedSplitMembership({ ...row, membership_path: "memberships/other.tsv" }, null, fetchImpl),
    /pointer no longer matches/);
});
