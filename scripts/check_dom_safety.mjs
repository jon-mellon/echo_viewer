import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SITE_ROOT = path.resolve("site");
const EXCLUDED = new Set([
  path.join(SITE_ROOT, "vendor"),
  path.join(SITE_ROOT, "visjs-min.js"),
]);

const rules = [
  ["HTML string assignment", /\.(?:innerHTML|outerHTML)\s*=/g, null],
  ["HTML string insertion", /\.insertAdjacentHTML\s*\(/g, null],
  ["direct URL assignment", /\.(?:href|src)\s*=/g, null],
  ["inline event attribute", /\bon[a-z]+\s*=/gi, ".html"],
  ["inline event setAttribute", /\.setAttribute\s*\(\s*["']on[a-z]+["']/gi, null],
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (EXCLUDED.has(absolute)) continue;
    if (entry.isDirectory()) files.push(...await sourceFiles(absolute));
    else if (/\.(?:html|js|mjs)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

const violations = [];
for (const file of await sourceFiles(SITE_ROOT)) {
  const source = await readFile(file, "utf8");
  const lines = source.split("\n");
  for (const [label, pattern, extension] of rules) {
    if (extension && path.extname(file) !== extension) continue;
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(`${path.relative(process.cwd(), file)}:${line}: ${label}: ${lines[line - 1].trim()}`);
    }
  }
}

if (violations.length) {
  console.error("Unsafe DOM operations found:\n" + violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("DOM safety check passed.");
}
