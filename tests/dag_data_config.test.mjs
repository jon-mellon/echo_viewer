import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SCHEMA_PUBLICATION_ID, evidenceManifestUrl, evidenceSnapshotIdFromManifestUrl,
  groupingSchemaUrl, schemaPublicationId,
} from "../site/dag_data_config.mjs";

test("the grouping schema defaults to the canonical Supabase publication", () => {
  assert.equal(schemaPublicationId({ href: "http://localhost:8767/" }), DEFAULT_SCHEMA_PUBLICATION_ID);
  assert.equal(groupingSchemaUrl({ href: "http://localhost:8767/" }), "");
});

test("schema_url selects an arbitrary static schema base URL", () => {
  const remote = "https://raw.githubusercontent.com/org/repo/main/schema/";
  const href = `http://localhost:8767/?schema_url=${encodeURIComponent(remote)}`;
  assert.equal(groupingSchemaUrl({ href }), remote);
  assert.equal(schemaPublicationId({ href }), "");
});

test("R2 evidence is the sole configured evidence source", () => {
  assert.match(evidenceManifestUrl({ href: "https://viewer.example/" }),
    /^https:\/\/data\.epistemicinfra\.org\/evidence\/layouts\/browser-v2\//);
});

test("permalinks and publications select their matching immutable evidence snapshot", () => {
  const snapshot = "295d1e544255dacd869bfb09e8546cd020ace7b06a976280658e66c28af5f230";
  const expected = `https://data.epistemicinfra.org/evidence/layouts/browser-v2/${snapshot}/manifest.json`;
  assert.equal(evidenceManifestUrl({ href: `https://viewer.example/?data_version=${snapshot}` }), expected);
  assert.equal(evidenceManifestUrl({ href: "https://viewer.example/" }, snapshot), expected);
});

test("a permalink data_version takes precedence over the publication fallback", () => {
  const permalinkSnapshot = "295d1e544255dacd869bfb09e8546cd020ace7b06a976280658e66c28af5f230";
  const publicationSnapshot = "0cbb5b3bf27fbcde88e82cf5d810b8ad6c2cfbe9fdfea1b60be8f1e500a9b4ac";
  assert.equal(
    evidenceManifestUrl({ href: `https://viewer.example/?data_version=${permalinkSnapshot}` }, publicationSnapshot),
    `https://data.epistemicinfra.org/evidence/layouts/browser-v2/${permalinkSnapshot}/manifest.json`,
  );
});

test("invalid snapshot parameters cannot alter the evidence path", () => {
  const normal = evidenceManifestUrl({ href: "https://viewer.example/" });
  assert.equal(evidenceManifestUrl({ href: "https://viewer.example/?data_version=../../private" }), normal);
});

test("the permalink generator can recover the immutable directory ID from a manifest URL", () => {
  const snapshot = "0cbb5b3bf27fbcde88e82cf5d810b8ad6c2cfbe9fdfea1b60be8f1e500a9b4ac";
  assert.equal(evidenceSnapshotIdFromManifestUrl(
    `https://data.epistemicinfra.org/evidence/snapshots/${snapshot}/manifest.json`,
  ), snapshot);
  assert.equal(evidenceSnapshotIdFromManifestUrl(
    `https://data.epistemicinfra.org/evidence/layouts/browser-v2/${snapshot}/manifest.json`,
  ), snapshot);
  assert.equal(evidenceSnapshotIdFromManifestUrl("https://example.test/manifest.json"), "");
});
