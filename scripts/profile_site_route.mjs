import { createRequire } from "node:module";
import { resolve } from "node:path";

// Published schema files are immutable; the profiles read them from disk after the first fetch
// rather than downloading about 5 MB per cold page load from Supabase (see tests/support/supabase_cache.cjs).
const { installSupabaseCache } = createRequire(import.meta.url)("../tests/support/supabase_cache.cjs");

// An isolated browser context can test a working tree on an allowed evidence
// origin without taking over another task's preview server. Remote data still
// uses ordinary browser requests; only local application assets are fulfilled.
export async function routeProfileSite(context, url, directory) {
  await installSupabaseCache(context);
  if (!directory) return;
  const root = resolve(directory);
  await context.route(`${new URL(url).origin}/**`, async route => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}/`)) { await route.abort(); return; }
    await route.fulfill({ path: file });
  });
}
