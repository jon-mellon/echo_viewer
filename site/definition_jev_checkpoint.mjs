import { openLocalDatabase } from "./local_schema_store.mjs";

const RUNS = "jev_runs";
const BATCHES = "jev_batches";
const STORAGE_TIMEOUT_MS = 15_000;

const openJevDatabase = openLocalDatabase;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { transaction.abort(); } catch { /* The transaction may already have ended. */ }
      reject(new Error("Browser storage did not respond within 15 seconds."));
    }, STORAGE_TIMEOUT_MS);
    transaction.oncomplete = () => { clearTimeout(timer); resolve(); };
    transaction.onabort = () => {
      clearTimeout(timer);
      reject(transaction.error || new Error("Could not save classification progress."));
    };
    transaction.onerror = () => {
      clearTimeout(timer);
      reject(transaction.error || new Error("Could not save classification progress."));
    };
  });
}

export async function jevRunId(source) {
  const bytes = new TextEncoder().encode(JSON.stringify(source));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function loadJevRun(id) {
  const db = await openJevDatabase();
  const tx = db.transaction([RUNS, BATCHES], "readonly");
  const done = transactionDone(tx);
  const runRequest = tx.objectStore(RUNS).get(id);
  const batchRequest = tx.objectStore(BATCHES).index("runId").getAll(id);
  const [run, batches] = await Promise.all([requestResult(runRequest), requestResult(batchRequest), done]);
  return run ? { run, batches } : null;
}

export async function latestJevRun() {
  const db = await openJevDatabase();
  const tx = db.transaction(RUNS, "readonly");
  const done = transactionDone(tx);
  const [runs] = await Promise.all([requestResult(tx.objectStore(RUNS).getAll()), done]);
  return runs.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}

export async function saveJevRun(run) {
  const db = await openJevDatabase();
  const tx = db.transaction(RUNS, "readwrite");
  tx.objectStore(RUNS).put(run);
  await transactionDone(tx);
}

export async function saveJevBatch(runId, phase, offset, results, inputTokens) {
  const db = await openJevDatabase();
  const tx = db.transaction(BATCHES, "readwrite");
  tx.objectStore(BATCHES).put({ key: `${runId}:${phase}:${offset}`, runId, phase, offset,
    results, inputTokens });
  await transactionDone(tx);
}

export async function deleteJevRun(id) {
  if (!id) return;
  const db = await openJevDatabase();
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
