import assert from "node:assert/strict";
import test from "node:test";

import { manifestFileEntries } from "../site/dag_manifest.mjs";

test("manifest relations become quoted SQL identifiers", () => {
  assert.deepEqual(manifestFileEntries({
    build_metadata: { url: "metadata.parquet" },
    select: { url: "reserved-word.parquet" },
  }), [
    { relation: "build_metadata", sqlIdentifier: '"build_metadata"', file: { url: "metadata.parquet" } },
    { relation: "select", sqlIdentifier: '"select"', file: { url: "reserved-word.parquet" } },
  ]);
});

test("manifest relations reject SQL fragments and malformed file records", () => {
  for (const relation of ["records; DROP VIEW records", 'records" AS SELECT 1--', "two words", "9records"]) {
    assert.throws(
      () => manifestFileEntries({ [relation]: { url: "data.parquet" } }),
      /Invalid evidence relation name/,
    );
  }
  assert.throws(() => manifestFileEntries(null), /files must be an object/);
  assert.throws(() => manifestFileEntries([]), /files must be an object/);
  assert.throws(() => manifestFileEntries({ records: {} }), /nonempty file URL/);
});
