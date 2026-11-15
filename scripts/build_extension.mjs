import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REVIEW_URLS = Object.freeze({
  production: "https://echo.epistemicinfra.org/paper-review.html",
  staging: "https://www.jonathanmellon.com/echo_viewer_staging/paper-review.html",
});
export async function buildExtension({ staging = false, destination = resolve("dist/extension") } = {}) {
  const reviewUrl = staging ? REVIEW_URLS.staging : REVIEW_URLS.production;
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(new URL("../extension/", import.meta.url), destination, { recursive: true });
  await writeFile(resolve(destination, "config.mjs"), `export const REVIEW_URL = ${JSON.stringify(reviewUrl)};\n`);
  const manifestPath = resolve(destination, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages
    .replace("frame-src https://echo.epistemicinfra.org", `frame-src ${new URL(reviewUrl).origin}`);
  if (staging) manifest.name += " (Staging)";
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return destination;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Built unpacked extension: ${await buildExtension({ staging: process.argv.includes("--staging") })}`);
}
