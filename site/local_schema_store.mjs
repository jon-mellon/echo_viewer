const DATABASE = "echo-local-schemas";
const SCHEMAS = "schemas";
const META = "meta";
const JEV_RUNS = "jev_runs";
const JEV_BATCHES = "jev_batches";
const SESSION_PREFIX = "session:";
const OPEN_TIMEOUT_MS = 15_000;

let databasePromise;

export function openLocalDatabase(indexedDb = globalThis.indexedDB, timeoutMs = OPEN_TIMEOUT_MS) {
  if (!indexedDb) return Promise.reject(new Error("IndexedDB is unavailable in this browser."));
  if (indexedDb === globalThis.indexedDB && databasePromise) return databasePromise;
  const opened = new Promise((resolve, reject) => {
    const request = indexedDb.open(DATABASE, 2);
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      callback(value);
      return true;
    };
    const timer = setTimeout(() => finish(reject, new Error(
      "Browser storage did not open within 15 seconds. Close other Echo tabs and reload this page, then try again.",
    )), timeoutMs);
    request.onupgradeneeded = () => {
      if (settled) {
        try { request.transaction?.abort(); } catch { /* The upgrade may already have ended. */ }
        return;
      }
      const db = request.result;
      if (!db.objectStoreNames.contains(SCHEMAS)) db.createObjectStore(SCHEMAS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
      if (!db.objectStoreNames.contains(JEV_RUNS)) db.createObjectStore(JEV_RUNS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(JEV_BATCHES)) {
        const batches = db.createObjectStore(JEV_BATCHES, { keyPath: "key" });
        batches.createIndex("runId", "runId");
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => {
        request.result.close();
        if (indexedDb === globalThis.indexedDB) databasePromise = null;
      };
      finish(resolve, request.result);
    };
    request.onerror = () => finish(reject, request.error);
    request.onblocked = () => finish(reject, new Error(
      "Local schema database is blocked by another Echo tab. Close other Echo tabs and reload this page.",
    ));
  });
  if (indexedDb === globalThis.indexedDB) {
    databasePromise = opened.catch(error => {
      databasePromise = null;
      throw error;
    });
    return databasePromise;
  }
  return opened;
}

function transaction(db, stores, mode, durability) {
  if (!durability) return db.transaction(stores, mode);
  try { return db.transaction(stores, mode, { durability }); }
  catch { return db.transaction(stores, mode); }
}

function requestResult(request, tx) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error || tx.error);
  });
}

export async function loadLocalSchema(id, indexedDb) {
  const db = await openLocalDatabase(indexedDb);
  const tx = transaction(db, [SCHEMAS], "readonly");
  return requestResult(tx.objectStore(SCHEMAS).get(id), tx);
}

export async function listPreviousSessions(indexedDb) {
  const db = await openLocalDatabase(indexedDb);
  const tx = transaction(db, [META], "readonly");
  const records = await requestResult(tx.objectStore(META).getAll(), tx);
  return (records || []).filter(record => record.key?.startsWith(SESSION_PREFIX))
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

// An update's sequence is assigned when the viewer changes, not when the
// asynchronous transaction starts. This lets a late old write lose safely.
export function urlSequence() {
  return performance.timeOrigin + performance.now();
}

export async function mirrorSessionUrl(sessionId, url, sequence = urlSequence(), title = "", indexedDb) {
  if (!sessionId) throw new Error("A session ID is required to save this view.");
  const db = await openLocalDatabase(indexedDb);
  return new Promise((resolve, reject) => {
    const tx = transaction(db, [META], "readwrite", "relaxed");
    const store = tx.objectStore(META);
    store.get(`${SESSION_PREFIX}${sessionId}`).onsuccess = event => {
      const current = event.target.result;
      if (!current || sequence >= current.sequence) {
        const now = new Date().toISOString();
        store.put({ key: `${SESSION_PREFIX}${sessionId}`, id: sessionId, url, sequence,
          title: title || current?.title || "Untitled view",
          createdAt: current?.createdAt || now, updatedAt: now });
      }
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("Could not save this view."));
    tx.onerror = () => reject(tx.error || new Error("Could not save this view."));
  });
}

export async function commitLocalSchema({ id, expectedRevision = 0, schema, url,
  sequence = urlSequence(), basePublicationId = null, basePublicationHash = null,
  lastPublishedId = null, lastPublishedHash = null, sessionId = null,
  sessionTitle = "" }, indexedDb) {
  const db = await openLocalDatabase(indexedDb);
  return new Promise((resolve, reject) => {
    const tx = transaction(db, [SCHEMAS, META], "readwrite", "strict");
    const schemas = tx.objectStore(SCHEMAS);
    const meta = tx.objectStore(META);
    let record;
    let conflict = false;
    schemas.get(id).onsuccess = event => {
      const prior = event.target.result || null;
      if ((prior?.revision || 0) !== expectedRevision) {
        conflict = true;
        tx.abort();
        return;
      }
      const now = new Date().toISOString();
      record = {
        id, formatVersion: 1, revision: expectedRevision + 1, schema,
        basePublicationId: prior?.basePublicationId || basePublicationId,
        basePublicationHash: prior?.basePublicationHash || basePublicationHash,
        lastPublishedId: lastPublishedId || prior?.lastPublishedId || null,
        lastPublishedHash: lastPublishedHash || prior?.lastPublishedHash || null,
        createdAt: prior?.createdAt || now, updatedAt: now,
      };
      schemas.put(record);
      if (sessionId) meta.get(`${SESSION_PREFIX}${sessionId}`).onsuccess = sessionEvent => {
        const current = sessionEvent.target.result;
        if (!current || sequence >= current.sequence) {
          meta.put({ key: `${SESSION_PREFIX}${sessionId}`, id: sessionId, url, sequence,
            title: sessionTitle || current?.title || "Untitled view",
            createdAt: current?.createdAt || now, updatedAt: now });
        }
      };
    };
    tx.oncomplete = () => resolve(record);
    tx.onabort = () => reject(conflict
      ? new Error("Schema revision changed in another tab.")
      : (tx.error || new Error("Local schema save failed.")));
    tx.onerror = () => reject(tx.error || new Error("Could not save the local schema."));
  });
}

export async function updateLocalPublication(id, expectedRevision, publication, indexedDb) {
  const db = await openLocalDatabase(indexedDb);
  return new Promise((resolve, reject) => {
    const tx = transaction(db, [SCHEMAS], "readwrite", "strict");
    let updated;
    const store = tx.objectStore(SCHEMAS);
    store.get(id).onsuccess = event => {
      const record = event.target.result;
      if (!record || record.revision !== expectedRevision) { tx.abort(); return; }
      updated = { ...record, lastPublishedId: publication.publication_id,
        lastPublishedHash: publication.content_hash, updatedAt: new Date().toISOString() };
      store.put(updated);
    };
    tx.oncomplete = () => resolve(updated);
    tx.onabort = () => reject(tx.error || new Error("Local schema changed before publication metadata was saved."));
    tx.onerror = () => reject(tx.error || new Error("Could not save publication metadata."));
  });
}
