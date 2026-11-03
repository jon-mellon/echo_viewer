import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("the source default is Cloudflare, so no deploy needs to rewrite it", () => {
  assert.equal(read("../site/schema_source.mjs").split('export const DEFAULT_SCHEMA_SOURCE = "cloudflare";').length - 1, 1);
  for (const workflow of ["deploy-staging.yml", "pages.yml"]) {
    assert.equal(read(`../.github/workflows/${workflow}`).includes("DEFAULT_SCHEMA_SOURCE"), false, `${workflow} does not change the default`);
  }
});

test("the Supabase client is created on first use, not on import", () => {
  const client = read("../site/supabase_client.mjs");
  assert.equal(/=\s*hasSupabaseConfig\(\)\s*\?\s*createClient/.test(client), false);
  assert.ok(client.includes("new Proxy"));
});
