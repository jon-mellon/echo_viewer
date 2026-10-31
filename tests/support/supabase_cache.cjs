// Published schema folders are immutable (the upload tooling refuses to replace
// a differing object), but every test starts a fresh browser that would download
// the whole bundle again: about 5 MB over 118 requests per page load, which added
// up to Supabase's free cached-egress quota. Keep each file on disk after its
// first fetch and serve later requests from there.
//
//   ECHO_SUPABASE_CACHE=<dir>        where files are kept (default .cache/supabase-published)
//   ECHO_NO_SUPABASE_CACHE=1         always go to the network
//   ECHO_SUPABASE_CACHE_VERBOSE=1    log each file fetched from the network
//   ECHO_SUPABASE_CACHE_VERBOSE=2    also log each file served from disk, with the bytes Supabase would send
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const STORAGE_OBJECT = /\/storage\/v1\/object\/public\/published-schemas\//;

function cacheDirectory() {
  return process.env.ECHO_SUPABASE_CACHE || path.resolve(".cache/supabase-published");
}

async function installSupabaseCache(context) {
  if (process.env.ECHO_NO_SUPABASE_CACHE === "1") return;
  const directory = cacheDirectory();
  fs.mkdirSync(directory, { recursive: true });
  await context.route(STORAGE_OBJECT, async route => {
    const request = route.request();
    if (request.method() !== "GET") return route.fallback();
    const key = crypto.createHash("sha256").update(request.url()).digest("hex");
    const bodyPath = path.join(directory, `${key}.body`);
    const metaPath = path.join(directory, `${key}.json`);
    if (fs.existsSync(bodyPath) && fs.existsSync(metaPath)) {
      const saved = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (process.env.ECHO_SUPABASE_CACHE_VERBOSE === "2") console.log(`[supabase-cache] served ${saved.wire ?? 0} ${request.url()}`);
      return route.fulfill({ status: 200, headers: saved.headers, body: fs.readFileSync(bodyPath) });
    }
    const response = await route.fetch();
    const body = response.status() === 200 ? await response.body() : null;
    // What Supabase sent over the wire (compressed), for measuring the egress this saves.
    const wire = Number(response.headers()["content-length"]) || (body ? body.length : 0);
    if (process.env.ECHO_SUPABASE_CACHE_VERBOSE) console.log(`[supabase-cache] fetched ${wire} ${request.url()}`);
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
      fs.writeFileSync(`${metaPath}.${stamp}`, JSON.stringify({ url: request.url(), headers, wire }));
      fs.renameSync(`${metaPath}.${stamp}`, metaPath);
    }
    return route.fulfill({ response });
  });
}

module.exports = { installSupabaseCache, cacheDirectory };
