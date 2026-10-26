// Mirror site/ into dist/new-data-site with the default schema publication and
// evidence snapshot pointed at a newer upload, so the browser suite can run
// unchanged against that data. Everything except dag_data_config.mjs is a
// symlink, so edits under site/ are picked up without re-running this script.
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = join(root, "site");
const outDir = join(root, "dist", "new-data-site");

export const NEW_DATA_PUBLICATION = process.env.NEW_DATA_PUBLICATION || "c221423a-9470-4c82-8a3d-8bcf4a01ef7c";
export const NEW_DATA_SNAPSHOT = process.env.NEW_DATA_SNAPSHOT
  || "f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b";

function replaceConstant(source, name, value) {
  const pattern = new RegExp(`(export const ${name} =\\s*)"[^"]*"`);
  if (!pattern.test(source)) throw new Error(`dag_data_config.mjs no longer defines ${name}.`);
  return source.replace(pattern, `$1${JSON.stringify(value)}`);
}

if (!/^[0-9a-f]{64}$/.test(NEW_DATA_SNAPSHOT)) throw new Error("NEW_DATA_SNAPSHOT must be a 64-character snapshot ID.");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
for (const entry of await readdir(siteDir)) {
  if (entry === "dag_data_config.mjs") continue;
  await symlink(join(siteDir, entry), join(outDir, entry));
}
let config = await readFile(join(siteDir, "dag_data_config.mjs"), "utf8");
config = replaceConstant(config, "DEFAULT_SCHEMA_PUBLICATION_ID", NEW_DATA_PUBLICATION);
config = replaceConstant(config, "PRODUCTION_EVIDENCE_MANIFEST",
  `https://data.epistemicinfra.org/evidence/layouts/browser-v2/${NEW_DATA_SNAPSHOT}/manifest.json`);
await writeFile(join(outDir, "dag_data_config.mjs"), config);
console.log(`New-data site: publication ${NEW_DATA_PUBLICATION}, snapshot ${NEW_DATA_SNAPSHOT}`);
