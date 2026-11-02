import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The staging deploy rewrites this exact line in the built site; if either side changes, staging would quietly stay on Supabase.
const DEFAULT_LINE = 'export const DEFAULT_SCHEMA_SOURCE = "supabase";';

test("the source default is the one line the staging deploy rewrites, and production keeps Supabase", () => {
  const source = readFileSync(new URL("../site/schema_source.mjs", import.meta.url), "utf8");
  assert.equal(source.split(DEFAULT_LINE).length - 1, 1);
  const workflow = readFileSync(new URL("../.github/workflows/deploy-staging.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes(DEFAULT_LINE), "the staging workflow looks for the default line");
  assert.ok(workflow.includes('export const DEFAULT_SCHEMA_SOURCE = "cloudflare";'), "and makes it Cloudflare");
  const pages = readFileSync(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  assert.equal(pages.includes("DEFAULT_SCHEMA_SOURCE"), false, "the production workflow does not change the default");
});

test("the staging step runs right after the build and before the profile checks, so they measure what ships", () => {
  const workflow = readFileSync(new URL("../.github/workflows/deploy-staging.yml", import.meta.url), "utf8");
  const at = marker => workflow.indexOf(marker);
  assert.ok(at("npm run build:site") < at("Make Cloudflare the staging default") && at("Make Cloudflare the staging default") < at("npm run profile:diagnostics"));
});
