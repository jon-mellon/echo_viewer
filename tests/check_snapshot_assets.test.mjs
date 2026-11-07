import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const SNAPSHOT = "a".repeat(64);
const FIXTURE = new URL("./fixtures/viewer-assets/", import.meta.url).pathname;
const SCRIPT = new URL("../scripts/check_snapshot_assets.mjs", import.meta.url).pathname;

function files(directory = FIXTURE) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

async function withHost(transform, work) {
  const served = new Map(files().map(path => [`/${SNAPSHOT}/viewer-assets/${relative(FIXTURE, path)}`, readFileSync(path)]));
  const server = createServer((request, response) => {
    let body = served.get(request.url);
    if (!body) { response.writeHead(404).end(); return; }
    body = transform(request.url, body);
    response.writeHead(200, { "content-length": body.length });
    response.end(request.method === "HEAD" ? undefined : body);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { return await work(`http://127.0.0.1:${server.address().port}/`); } finally { server.close(); }
}

const check = (base, snapshot = SNAPSHOT) => run("node", [SCRIPT, snapshot], { env: { ...process.env, ECHO_EVIDENCE_LAYOUTS_BASE: base } })
  .then(result => ({ code: 0, ...result }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));

test("the check passes when the published assets are complete and every file matches its manifest", async () => {
  await withHost((url, body) => body, async base => {
    const result = await check(base);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /published and verified/);
  });
});

test("the check fails when a published file has been changed", async () => {
  await withHost((url, body) => (url.endsWith("search-catalog.json.gz") ? Buffer.concat([body, Buffer.from([0])]) : body), async base => {
    const result = await check(base);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /search catalog: size or hash differs/);
  });
});

test("the check fails when a snapshot has no assets published or committed", async () => {
  await withHost((url, body) => body, async base => {
    const result = await check(base, "b".repeat(64));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no viewer assets, published or committed/);
  });
});
