import { openLocalDatabase } from "./local_schema_store.mjs";

const RUNS = "jev_runs";
const BATCHES = "jev_batches";

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error || new Error("Could not save Jev progress."));
    transaction.onerror = () => reject(transaction.error || new Error("Could not save Jev progress."));
  });
}

export async function jevRunId(source) {
  const bytes = new TextEncoder().encode(JSON.stringify(source));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function loadJevRun(id) {
  const db = await openLocalDatabase();
  const tx = db.transaction([RUNS, BATCHES], "readonly");
  const runRequest = tx.objectStore(RUNS).get(id);
  const batchRequest = tx.objectStore(BATCHES).index("runId").getAll(id);
  const [run, batches] = await Promise.all([requestResult(runRequest), requestResult(batchRequest)]);
  await transactionDone(tx);
  return run ? { run, batches } : null;
}

export async function latestJevRun() {
  const db = await openLocalDatabase();
  const tx = db.transaction(RUNS, "readonly");
  const runs = await requestResult(tx.objectStore(RUNS).getAll());
  await transactionDone(tx);
  return runs.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}

export async function saveJevRun(run) {
  const db = await openLocalDatabase();
  const tx = db.transaction(RUNS, "readwrite");
  tx.objectStore(RUNS).put(run);
  await transactionDone(tx);
}

export async function saveJevBatch(runId, phase, offset, results, inputTokens) {
  const db = await openLocalDatabase();
  const tx = db.transaction(BATCHES, "readwrite");
  tx.objectStore(BATCHES).put({ key: `${runId}:${phase}:${offset}`, runId, phase, offset,
    results, inputTokens });
  await transactionDone(tx);
}

export async function deleteJevRun(id) {
  if (!id) return;
  const db = await openLocalDatabase();
  const tx = db.transaction([RUNS, BATCHES], "readwrite");
  tx.objectStore(RUNS).delete(id);
  const index = tx.objectStore(BATCHES).index("runId");
  const cursor = index.openKeyCursor(id);
  cursor.onsuccess = () => {
    const item = cursor.result;
    if (item) {
      tx.objectStore(BATCHES).delete(item.primaryKey);
      item.continue();
    }
  };
  await transactionDone(tx);
}
