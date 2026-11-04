// Cache immutable Cloudflare R2 schema objects across browser test contexts.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PUBLIC_OBJECT = /^https:\/\/data\.epistemicinfra\.org\/published-schemas\//;
const cacheDirectory = () => process.env.ECHO_PUBLISHED_SCHEMA_CACHE || path.resolve(".cache/published-schemas");

async function installPublishedSchemaCache(context) {
  if (process.env.ECHO_NO_PUBLISHED_SCHEMA_CACHE === "1") return;
  const directory = cacheDirectory();
  fs.mkdirSync(directory, { recursive: true });
  await context.route(PUBLIC_OBJECT, async route => {
    const request = route.request();
    if (request.method() !== "GET") return route.fallback();
    const url = request.url();
    const key = crypto.createHash("sha256").update(url).digest("hex");
    const bodyPath = path.join(directory, `${key}.body`);
    const metaPath = path.join(directory, `${key}.json`);
    if (fs.existsSync(bodyPath) && fs.existsSync(metaPath)) {
      const saved = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      return route.fulfill({ status: 200, headers: saved.headers, body: fs.readFileSync(bodyPath) });
    }
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body = await response.body();
    const headers = { "access-control-allow-origin": "*" };
    for (const name of ["content-type", "cache-control"]) {
      const value = response.headers()[name];
      if (value) headers[name] = value;
    }
    const stamp = `${process.pid}.${Date.now()}`;
    fs.writeFileSync(`${bodyPath}.${stamp}`, body);
    fs.renameSync(`${bodyPath}.${stamp}`, bodyPath);
    fs.writeFileSync(`${metaPath}.${stamp}`, JSON.stringify({ url, headers }));
    fs.renameSync(`${metaPath}.${stamp}`, metaPath);
    return route.fulfill({ status: 200, headers, body });
  });
}

module.exports = { installPublishedSchemaCache, cacheDirectory };
