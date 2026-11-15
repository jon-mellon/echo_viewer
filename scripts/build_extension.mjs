import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REVIEW_URLS = Object.freeze({
  permastaging: "https://www.jonathanmellon.com/echo_viewer_permastaging/paper-review.html",
});
export async function buildExtension({ permastaging = true, destination = resolve("dist/extension") } = {}) {
  if (!permastaging) throw new Error("Production paper review is disabled. Only permastaging packages are available.");
  const reviewUrl = REVIEW_URLS.permastaging;
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(new URL("../extension/", import.meta.url), destination, { recursive: true });
  await writeFile(resolve(destination, "config.mjs"), `export const REVIEW_URL = ${JSON.stringify(reviewUrl)};\n`);
  const manifestPath = resolve(destination, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages
    .replace("frame-src https://www.jonathanmellon.com", `frame-src ${new URL(reviewUrl).origin}`);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return destination;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Built unpacked extension: ${await buildExtension({ permastaging: !process.argv.includes("--production") })}`);
}
