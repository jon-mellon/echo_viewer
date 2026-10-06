import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "../scripts/build_site.mjs";

test("every deployed module URL changes together when source changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-site-build-"));
  const source = join(root, "site");
  const output = join(root, "output");
  try {
    await mkdir(source);
    await writeFile(join(source, "index.html"), '<link href="/styles.css?v=old"><script type="module" src="/main.js?v=old"></script>');
    await writeFile(join(source, "main.js"), 'import "./child.mjs?v=old"; new Worker(new URL("./worker.mjs", import.meta.url));');
    await writeFile(join(source, "child.mjs"), 'export const value = 1;');
    await writeFile(join(source, "worker.mjs"), 'export const ready = true;');
    await writeFile(join(source, "styles.css"), "body {}");

    const first = await buildSite(source, output);
    assert.match(await readFile(join(output, "index.html"), "utf8"),
      new RegExp(`/main\\.js\\?v=${first}`));
    assert.match(await readFile(join(output, "index.html"), "utf8"),
      new RegExp(`/styles\\.css\\?v=${first}`));
    assert.equal(await readFile(join(output, "main.js"), "utf8"),
      `import "./child.mjs?v=${first}"; new Worker(new URL("./worker.mjs?v=${first}", import.meta.url));`);

    await writeFile(join(source, "child.mjs"), 'export const value = 2;');
    const second = await buildSite(source, output);
    assert.notEqual(second, first);
    assert.match(await readFile(join(output, "index.html"), "utf8"),
      new RegExp(`/main\\.js\\?v=${second}`));
    assert.match(await readFile(join(output, "main.js"), "utf8"),
      new RegExp(`child\\.mjs\\?v=${second}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
