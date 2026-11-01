import { createRequire } from "node:module";
import { resolve } from "node:path";

// Published schema files are immutable; the profiles read them from disk after the first fetch
// rather than downloading about 5 MB per cold page load from Supabase (see tests/support/supabase_cache.cjs).
const require = createRequire(import.meta.url);
const { installSupabaseCache } = require("../tests/support/supabase_cache.cjs");
// The profiles run the viewer as staging ships it, on the Cloudflare schema source (see tests/support/default_source.cjs).
const { installDefaultSource, isSchemaSource, schemaSourceFromDisk } = require("../tests/support/default_source.cjs");

// An isolated browser context can test a working tree on an allowed evidence
// origin without taking over another task's preview server. Remote data still
// uses ordinary browser requests; only local application assets are fulfilled.
export async function routeProfileSite(context, url, directory) {
  await installSupabaseCache(context);
  await installDefaultSource(context);
  if (!directory) return;
  const root = resolve(directory);
  await context.route(`${new URL(url).origin}/**`, async route => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}/`)) { await route.abort(); return; }
    if (isSchemaSource(route.request().url())) { await route.fulfill(schemaSourceFromDisk(file)); return; }
    await route.fulfill({ path: file });
  });
}
