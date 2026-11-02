import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { canonicalUrl, networkUrl } = createRequire(import.meta.url)("./support/supabase_cache.cjs");
const SUPABASE = "https://xfsivvvmsgzbdnthupzg.supabase.co/storage/v1/object/public/published-schemas/o/p/groups.tsv";
const CLOUDFLARE = "https://data.epistemicinfra.org/published-schemas/o/p/groups.tsv";

test("the test cache keeps one entry per file whichever address the page asked for", () => {
  assert.equal(canonicalUrl(SUPABASE), SUPABASE);
  assert.equal(canonicalUrl(CLOUDFLARE), SUPABASE);
});

test("a missing file is fetched from Cloudflare unless Supabase is asked for, and other addresses are left alone", () => {
  const saved = process.env.ECHO_FETCH_SCHEMAS_FROM;
  try {
    delete process.env.ECHO_FETCH_SCHEMAS_FROM;
    assert.equal(networkUrl(SUPABASE), CLOUDFLARE, "CI sends no schema traffic to Supabase");
    process.env.ECHO_FETCH_SCHEMAS_FROM = "supabase";
    assert.equal(networkUrl(SUPABASE), SUPABASE);
    delete process.env.ECHO_FETCH_SCHEMAS_FROM;
    assert.equal(networkUrl("https://echo-api.epistemicinfra.org/v1/schemas/x"), "https://echo-api.epistemicinfra.org/v1/schemas/x");
  } finally {
    if (saved === undefined) delete process.env.ECHO_FETCH_SCHEMAS_FROM; else process.env.ECHO_FETCH_SCHEMAS_FROM = saved;
  }
});
