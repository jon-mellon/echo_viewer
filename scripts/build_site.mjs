import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function stagingDataConfig(source) {
  const publication = process.env.DEFAULT_DATA_PUBLICATION || "";
  const snapshot = process.env.DEFAULT_DATA_SNAPSHOT || "";
  if (!publication && !snapshot) return null;
  if (!publication || !snapshot) {
    throw new Error("Set DEFAULT_DATA_PUBLICATION and DEFAULT_DATA_SNAPSHOT together.");
  }
  if (!/^[0-9a-f]{64}$/.test(snapshot)) {
    throw new Error("DEFAULT_DATA_SNAPSHOT must be a 64-character snapshot ID.");
  }
  let config = source;
  const replaceConstant = (name, value) => {
    const pattern = new RegExp(`(export const ${name} =\\s*)"[^"]*"`);
    if (!pattern.test(config)) throw new Error(`dag_data_config.mjs no longer defines ${name}.`);
    config = config.replace(pattern, `$1${JSON.stringify(value)}`);
  };
  replaceConstant("DEFAULT_SCHEMA_PUBLICATION_ID", publication);
  replaceConstant(
    "PRODUCTION_EVIDENCE_MANIFEST",
    `https://data.epistemicinfra.org/evidence/layouts/browser-v2/${snapshot}/manifest.json`,
  );
  return config;
}

export async function buildSite(source, destination) {
  const files = await filesIn(source);
  const hash = createHash("sha256");
  const hasDataOverride = process.env.DEFAULT_DATA_PUBLICATION || process.env.DEFAULT_DATA_SNAPSHOT;
  const configuredConfig = hasDataOverride
    ? stagingDataConfig(await readFile(join(source, "dag_data_config.mjs"), "utf8"))
    : null;
  for (const file of files) {
    hash.update(relative(source, file));
    const content = relative(source, file) === "dag_data_config.mjs" && configuredConfig
      ? configuredConfig
      : await readFile(file);
    hash.update(content);
  }
  const version = hash.digest("hex").slice(0, 16);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true });
  if (configuredConfig) await writeFile(join(destination, "dag_data_config.mjs"), configuredConfig);

  for (const file of files) {
    const target = join(destination, relative(source, file));
    if (/\.(?:m?js)$/.test(file) && !relative(source, file).startsWith(`vendor/`)
      && !file.endsWith("visjs-min.js")) {
      const code = await readFile(file, "utf8");
      // Give every local module and module worker the same release URL. A new
      // HTML page can then never combine with an older cached dependency.
      const versioned = code.replace(/(["'])((?:\/|\.{1,2}\/)[^"'\n]*?\.m?js)(?:\?[^"'\n]*)?\1/g,
        (_, quote, path) => `${quote}${path}?v=${version}${quote}`);
      if (versioned !== code) await writeFile(target, versioned);
    } else if (relative(source, file) === "index.html") {
      const html = await readFile(file, "utf8");
      const versioned = html.replace(/(src|href)=(["'])(\/[^"'\n]*?\.(?:m?js|css))(?:\?[^"'\n]*)?\2/g,
        (_, attribute, quote, path) => `${attribute}=${quote}${path}?v=${version}${quote}`);
      await writeFile(target, versioned);
    }
  }
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = resolve(process.argv[2] || "site");
  const destination = resolve(process.argv[3] || "dist/site");
  console.log(`Built ${destination} with release ${await buildSite(source, destination)}`);
}
