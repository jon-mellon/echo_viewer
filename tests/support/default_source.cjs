// Browser tests and the profile scripts run the viewer the way staging ships it: reading published schemas from Cloudflare
// by default, so CI makes no Supabase calls. The repo's real default stays Supabase (production); this rewrites that one
// line as the page loads (as the staging deploy does), without touching any file.
//
//   ECHO_TEST_DEFAULT_SOURCE=supabase   run the tests on the repo's own default instead
const fs = require("node:fs");

const SUPABASE_LINE = 'export const DEFAULT_SCHEMA_SOURCE = "supabase";';
const CLOUDFLARE_LINE = 'export const DEFAULT_SCHEMA_SOURCE = "cloudflare";';
const testDefaultSource = () => process.env.ECHO_TEST_DEFAULT_SOURCE === "supabase" ? "supabase" : "cloudflare";

/** schema_source.mjs as the tests should see it. Already-Cloudflare text (a staging build) is left alone. */
function withTestDefault(text) {
  if (testDefaultSource() === "supabase" || text.includes(CLOUDFLARE_LINE)) return text;
  if (!text.includes(SUPABASE_LINE)) throw new Error("schema_source.mjs changed; update tests/support/default_source.cjs");
  return text.replace(SUPABASE_LINE, CLOUDFLARE_LINE);
}

const isSchemaSource = url => /\/schema_source\.mjs(\?.*)?$/.test(new URL(url).pathname + new URL(url).search);

async function installDefaultSource(context) {
  // ECHO_LOG_SUPABASE_CALLS=<file> records each request that really reaches Supabase (the disk cache answers the schema files,
  // so what is left is things like registry reads), to show what a run still depends on it for.
  if (process.env.ECHO_LOG_SUPABASE_CALLS) {
    await context.route(/\.supabase\.co\//, async route => {
      fs.appendFileSync(process.env.ECHO_LOG_SUPABASE_CALLS, `${route.request().method()} ${route.request().url().slice(0, 140)}\n`);
      await route.fallback();
    });
  }
  await context.route(request => isSchemaSource(request.href ?? request), async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: withTestDefault(await response.text()) });
  });
}

/** For a route that serves files from disk itself (the profile scripts). */
function schemaSourceFromDisk(file) {
  return { contentType: "text/javascript", body: withTestDefault(fs.readFileSync(file, "utf8")) };
}

module.exports = { installDefaultSource, withTestDefault, schemaSourceFromDisk, isSchemaSource, testDefaultSource };
