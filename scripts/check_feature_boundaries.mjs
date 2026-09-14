import { readFile } from "node:fs/promises";
import process from "node:process";

const behaviorModules = [
  "site/definition_workflow_controller.mjs",
  "site/grouping_set_controller.mjs",
  "site/project_bootstrap.mjs",
  "site/toolbar_controller.mjs",
  "site/uoa_controller.mjs",
];

const forbidden = [
  ["DOM global", /\b(?:document|HTMLElement|Element)\b/g],
  ["DOM construction import", /from\s+["']\.\/dom_builder\.mjs["']/g],
  ["DOM query", /\.(?:querySelector|querySelectorAll|getElementById)\s*\(/g],
  ["DOM presentation mutation", /\.(?:innerHTML|textContent|className|classList|hidden|disabled)\b/g],
];

const violations = [];
for (const file of behaviorModules) {
  const source = await readFile(file, "utf8");
  for (const [label, pattern] of forbidden) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(`${file}:${line}: ${label}`);
    }
  }
}

if (violations.length) {
  console.error("Feature boundary violations found:\n" + violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Feature controller/presenter boundaries passed.");
}
