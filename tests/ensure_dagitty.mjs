import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  DAGITTY_CACHE_URL,
  DAGITTY_GIT_COMMIT,
  DAGITTY_GIT_URL,
  DAGITTY_MODULE_URL,
} from "./dagitty_dependency.mjs";

const cachePath = fileURLToPath(DAGITTY_CACHE_URL);
const modulePath = fileURLToPath(DAGITTY_MODULE_URL);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let cacheMatches = false;
if (await exists(new URL(".git/", DAGITTY_CACHE_URL))) {
  try {
    cacheMatches = git(["-C", cachePath, "rev-parse", "HEAD"]) === DAGITTY_GIT_COMMIT;
  } catch {
    cacheMatches = false;
  }
}

if (!cacheMatches) {
  await rm(cachePath, { recursive: true, force: true });
  git(["clone", "--filter=blob:none", "--no-checkout", DAGITTY_GIT_URL, cachePath]);
  git(["-C", cachePath, "checkout", "--detach", DAGITTY_GIT_COMMIT]);
}

const jslib = new URL("jslib/", DAGITTY_CACHE_URL);
const sourceFiles = [
  "node-pre.js",
  "graph/Class.js",
  "graph/Hash.js",
  "graph/Graph.js",
  "graph/GraphAnalyzer.js",
  "graph/GraphLayouter.js",
  "graph/GraphParser.js",
  "graph/GraphTransformer.js",
  "graph/GraphGenerator.js",
  "graph/ObservedGraph.js",
  "graph/GraphSerializer.js",
  "graph/MPolynomials.js",
  "parser/GraphDotParser.js",
  "node-post.js",
];
const source = (await Promise.all(
  sourceFiles.map((relativePath) => readFile(new URL(relativePath, jslib), "utf8")),
)).join("\n");
await writeFile(modulePath, source);
await writeFile(
  new URL("package.json", jslib),
  `${JSON.stringify({ private: true, type: "commonjs" }, null, 2)}\n`,
);

// Dagitty's Node prelude requires the npm `underscore` package. The pinned
// repository already contains the compatible browser build, so expose that
// exact bundled version through Node's normal package resolution.
const underscoreDir = new URL("jslib/node_modules/underscore/", DAGITTY_CACHE_URL);
await mkdir(underscoreDir, { recursive: true });
await writeFile(
  new URL("package.json", underscoreDir),
  `${JSON.stringify({ name: "underscore", private: true, main: "index.js" }, null, 2)}\n`,
);
await writeFile(
  new URL("index.js", underscoreDir),
  'module.exports = require("../../graph/underscore-min.js");\n',
);

console.log(`Dagitty ${DAGITTY_GIT_COMMIT} ready at ${modulePath}`);
