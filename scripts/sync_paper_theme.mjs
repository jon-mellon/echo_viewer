// Reuse the main ECHO site's actual design tokens in the hosted and packaged UI.
import { readFile, writeFile } from 'node:fs/promises';
const source = await readFile(new URL('../site/styles.css', import.meta.url), 'utf8');
const tokens = source.slice(source.indexOf(':root {'), source.indexOf('}', source.indexOf(':root {')) + 1);
const css = `/* Generated from site/styles.css by scripts/sync_paper_theme.mjs. */\n${tokens}\n`;
for (const path of ['../site/paper_theme.css', '../extension/theme.css']) {
  const target = new URL(path, import.meta.url);
  if (process.argv.includes('--check')) {
    if (await readFile(target, 'utf8') !== css) throw new Error(`ECHO design tokens differ: ${path}`);
  } else await writeFile(target, css);
}
