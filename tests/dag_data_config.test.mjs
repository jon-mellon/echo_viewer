import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SCHEMA_PUBLICATION_ID, evidenceManifestUrl, groupingSchemaUrl, schemaPublicationId,
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
    /^https:\/\/data\.epistemicinfra\.org\/evidence\/snapshots\//);
});
