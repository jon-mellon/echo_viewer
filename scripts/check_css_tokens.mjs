// Fails when site/styles.css uses a raw value where a design token is required.
// Tokens live in :root; everywhere else, type, spacing, colour, radius and
// elevation must come from them. Mark a deliberate exception with
// `/* token-exempt */` on the same line.
import { readFileSync } from "node:fs";

const file = new URL("../site/styles.css", import.meta.url);
const css = readFileSync(file, "utf8");

const COLOR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|(?<![\w-])(white|black)(?![\w-])/i;
const SPACING = /^(padding|margin|gap|row-gap|column-gap)(-|$)/;
const LITERAL_PX = /(?<![\w.-])(\d+(?:\.\d+)?)px\b/g;
const rules = [
  { test: prop => prop === "font-size", ok: v => /^(var\(--text-[a-z]+\)|inherit|0|1em)$/.test(v), why: "font-size must be a --text-* token" },
  { test: prop => prop === "font-weight", ok: v => /^(var\(--weight-[a-z]+\)|inherit|normal)$/.test(v), why: "font-weight must be a --weight-* token" },
  { test: prop => prop === "line-height", ok: v => /^(var\(--leading-[a-z]+\)|1|inherit|normal|0)$/.test(v), why: "line-height must be a --leading-* token" },
  { test: prop => prop === "border-radius", ok: v => v.split(/\s+/).every(part => /^(var\(--radius-[a-z]+\)|0|50%|inherit)$/.test(part)), why: "border-radius must be a --radius-* token" },
  {
    test: prop => SPACING.test(prop),
    ok: v => [...v.matchAll(LITERAL_PX)].every(match => Number(match[1]) <= 2),
    why: "spacing must use --space-* tokens (only 1–2px hairlines may be literal)",
  },
  { test: () => true, ok: (v, prop) => !COLOR.test(v) || prop.startsWith("--") || prop === "white-space", why: "colours must be tokens" },
  { test: () => true, ok: (v, prop) => !/!important/.test(v) || prop === "display", why: "!important is only allowed on display" },
];

const problems = [];
const rootEnd = (() => {
  const start = css.search(/:root\s*\{/);
  return start < 0 ? 0 : css.indexOf("}", start) + 1;
})();
const lines = css.split("\n");
let offset = 0;
lines.forEach((line, index) => {
  const lineStart = offset;
  offset += line.length + 1;
  if (lineStart < rootEnd || line.includes("token-exempt")) return;
  const code = line.replace(/\/\*.*?\*\//g, "");
  for (const match of code.matchAll(/(?:^|[;{\s])([a-z-]+)\s*:\s*([^;{}]+?)\s*(?=;|}|$)/g)) {
    const [, prop, value] = match;
    if (/^(hover|focus|active|not|has|is|where|nth-child|before|after)$/.test(prop)) continue;
    for (const rule of rules) {
      if (rule.test(prop) && !rule.ok(value, prop)) problems.push(`styles.css:${index + 1}  ${prop}: ${value}  — ${rule.why}`);
    }
  }
});

if (problems.length) {
  console.error(`CSS token check failed (${problems.length}):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("CSS token check passed.");
