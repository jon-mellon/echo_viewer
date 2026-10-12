import assert from "node:assert/strict";
import test from "node:test";
import { openLocalDatabase } from "../site/local_schema_store.mjs";

test("a timed-out database open can be retried and closes a late connection", async () => {
  const original = globalThis.indexedDB;
  const requests = [];
  const fake = { open() {
    const request = {};
    requests.push(request);
    return request;
  } };
  globalThis.indexedDB = fake;
  try {
    await assert.rejects(openLocalDatabase(fake, 1), /Close other Echo tabs/);
    const retried = openLocalDatabase(fake, 100);
    assert.equal(requests.length, 2);
    const db = { close() {} };
    requests[1].result = db;
    requests[1].onsuccess();
    assert.equal(await retried, db);
    let closed = false;
    requests[0].result = { close() { closed = true; } };
    requests[0].onsuccess();
    assert.equal(closed, true);
  } finally {
    globalThis.indexedDB = original;
  }
});
