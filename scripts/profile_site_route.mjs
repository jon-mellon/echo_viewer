import { resolve } from "node:path";

// An isolated browser context can test a working tree on an allowed evidence
// origin without taking over another task's preview server. Remote data still
// uses ordinary browser requests; only local application assets are fulfilled.
export async function routeProfileSite(context, url, directory) {
  if (!directory) return;
  const root = resolve(directory);
  await context.route(`${new URL(url).origin}/**`, async route => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}/`)) { await route.abort(); return; }
    await route.fulfill({ path: file });
  });
}
