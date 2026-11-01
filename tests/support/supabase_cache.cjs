// Published schema folders are immutable (the upload tooling refuses to replace
// a differing object), but every test starts a fresh browser that would download
// the whole bundle again: about 5 MB over 118 requests per page load, which added
// up to Supabase's free cached-egress quota. Keep each file on disk after its
// first fetch and serve later requests from there.
//
// A miss is fetched from the Cloudflare mirror (data.epistemicinfra.org), so CI sends no schema traffic to Supabase at all;
// the cache is keyed by the file, not by where it came from, so Supabase- and Cloudflare-addressed requests share entries.
//
//   ECHO_FETCH_SCHEMAS_FROM=supabase  fetch misses from Supabase instead (default: cloudflare)
//   ECHO_SUPABASE_CACHE=<dir>        where files are kept (default .cache/supabase-published)
//   ECHO_NO_SUPABASE_CACHE=1         always go to the network
//   ECHO_SUPABASE_CACHE_VERBOSE=1    log each file fetched from the network
//   ECHO_SUPABASE_CACHE_VERBOSE=2    also log each file served from disk, with the bytes Supabase would send
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const STORAGE_OBJECT = /\/storage\/v1\/object\/public\/published-schemas\//;
// The Cloudflare mirror holds the same files at the same keys, so the page may ask for either address.
const CLOUDFLARE_BASE = "https://data.epistemicinfra.org/published-schemas/";
const CLOUDFLARE_OBJECT = /^https:\/\/data\.epistemicinfra\.org\/published-schemas\//;
// The worker's registry answers for a Cloudflare page. Rows are immutable, so they are kept on disk like the files, and a
// page served from localhost (which the worker does not list for CORS) still gets them.
const WORKER_REGISTRY = /^https:\/\/echo-api\.epistemicinfra\.org\/v1\/(schemas|splits)/;
// A publication's registry row in Supabase's table (read only by a page that asks for the Supabase source). Rows never change, so
// they are kept on disk too and a warm run makes no Supabase call at all.
const SUPABASE_REGISTRY_ROW = /^https:\/\/xfsivvvmsgzbdnthupzg\.supabase\.co\/rest\/v1\/published_schemas\?/;
const SUPABASE_OBJECT_BASE = "https://xfsivvvmsgzbdnthupzg.supabase.co/storage/v1/object/public/published-schemas/";

/** A file's one canonical (Supabase-form) address, whichever address the page asked for. */
function canonicalUrl(url) {
  return url.startsWith(CLOUDFLARE_BASE) ? SUPABASE_OBJECT_BASE + url.slice(CLOUDFLARE_BASE.length) : url;
}

/** Where a missing file is fetched from: the Cloudflare mirror unless ECHO_FETCH_SCHEMAS_FROM=supabase. */
function networkUrl(canonical) {
  return process.env.ECHO_FETCH_SCHEMAS_FROM === "supabase" || !canonical.startsWith(SUPABASE_OBJECT_BASE)
    ? canonical : CLOUDFLARE_BASE + canonical.slice(SUPABASE_OBJECT_BASE.length);
}

function cacheDirectory() {
  return process.env.ECHO_SUPABASE_CACHE || path.resolve(".cache/supabase-published");
}

async function installSupabaseCache(context) {
  if (process.env.ECHO_NO_SUPABASE_CACHE === "1") return;
  const directory = cacheDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const serve = async (route, requestedUrl) => {
    const sourceUrl = canonicalUrl(requestedUrl);
    const request = route.request();
    if (request.method() !== "GET") return route.fallback();
    const key = crypto.createHash("sha256").update(sourceUrl).digest("hex");
    const bodyPath = path.join(directory, `${key}.body`);
    const metaPath = path.join(directory, `${key}.json`);
    if (fs.existsSync(bodyPath) && fs.existsSync(metaPath)) {
      const saved = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (process.env.ECHO_SUPABASE_CACHE_VERBOSE === "2") console.log(`[supabase-cache] served ${saved.wire ?? 0} ${sourceUrl}`);
      return route.fulfill({ status: 200, headers: saved.headers, body: fs.readFileSync(bodyPath) });
    }
    const fetchUrl = networkUrl(sourceUrl);
    const response = await route.fetch({ url: fetchUrl });
    const body = response.status() === 200 ? await response.body() : null;
    // What Supabase sent over the wire (compressed), for measuring the egress this saves.
    const wire = Number(response.headers()["content-length"]) || (body ? body.length : 0);
    if (process.env.ECHO_SUPABASE_CACHE_VERBOSE) console.log(`[supabase-cache] fetched ${wire} ${fetchUrl}`);
    if (response.status() === 200) {
      const headers = { "access-control-allow-origin": "*" };
      for (const name of ["content-type", "cache-control"]) {
        const value = response.headers()[name];
        if (value) headers[name] = value;
      }
      // Write the body first and the metadata last, each atomically, so a reader never sees half a file.
      const stamp = `${process.pid}.${Date.now()}`;
      fs.writeFileSync(`${bodyPath}.${stamp}`, body);
      fs.renameSync(`${bodyPath}.${stamp}`, bodyPath);
      fs.writeFileSync(`${metaPath}.${stamp}`, JSON.stringify({ url: sourceUrl, headers, wire }));
      fs.renameSync(`${metaPath}.${stamp}`, metaPath);
    }
    return route.fulfill({ response });
  };
  await context.route(STORAGE_OBJECT, route => serve(route, route.request().url()));
  await context.route(WORKER_REGISTRY, route => serve(route, route.request().url()));
  await context.route(SUPABASE_REGISTRY_ROW, route => serve(route, route.request().url()));
  await context.route(CLOUDFLARE_OBJECT, route => serve(route, route.request().url()));
}

module.exports = { installSupabaseCache, cacheDirectory, canonicalUrl, networkUrl };
