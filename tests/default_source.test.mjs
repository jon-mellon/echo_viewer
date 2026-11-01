import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { withTestDefault, isSchemaSource, testDefaultSource } = createRequire(import.meta.url)("./support/default_source.cjs");
const SUPABASE = 'export const DEFAULT_SCHEMA_SOURCE = "supabase";';
const CLOUDFLARE = 'export const DEFAULT_SCHEMA_SOURCE = "cloudflare";';

test("the tests run the viewer on Cloudflare, by rewriting the one default line, unless asked not to", () => {
  const saved = process.env.ECHO_TEST_DEFAULT_SOURCE;
  try {
    delete process.env.ECHO_TEST_DEFAULT_SOURCE;
    assert.equal(testDefaultSource(), "cloudflare");
    assert.equal(withTestDefault(`a\n${SUPABASE}\nb`), `a\n${CLOUDFLARE}\nb`);
    assert.equal(withTestDefault(CLOUDFLARE), CLOUDFLARE, "a staging build, already on Cloudflare, is left alone");
    assert.throws(() => withTestDefault("export const OTHER = 1;"), /schema_source\.mjs changed/, "a changed file fails loudly, not silently");
    process.env.ECHO_TEST_DEFAULT_SOURCE = "supabase";
    assert.equal(testDefaultSource(), "supabase");
    assert.equal(withTestDefault(SUPABASE), SUPABASE, "ECHO_TEST_DEFAULT_SOURCE=supabase runs on the repo's own default");
  } finally {
    if (saved === undefined) delete process.env.ECHO_TEST_DEFAULT_SOURCE; else process.env.ECHO_TEST_DEFAULT_SOURCE = saved;
  }
});

test("only the schema source module is rewritten, whether served from the root or below it, with or without a query", () => {
  assert.equal(isSchemaSource("http://127.0.0.1:8767/schema_source.mjs"), true);
  assert.equal(isSchemaSource("https://www.jonathanmellon.com/echo_viewer_staging/schema_source.mjs?v=1"), true);
  assert.equal(isSchemaSource("http://127.0.0.1:8767/dag_builder.js"), false);
  assert.equal(isSchemaSource("http://127.0.0.1:8767/my_schema_source.mjs"), false);
});
