const database = () => new Promise((resolve, reject) => {
  const request = indexedDB.open("echo-paper-review-v1", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("runs", { keyPath: "id" });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(new Error("Private review storage is unavailable. Open Echo in a tab to continue."));
});
async function transact(mode, operation) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("runs", mode), request = operation(transaction.objectStore("runs"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("Could not save the private review."));
    });
  } finally { db.close(); }
}
export const paperStore = {
  save: record => transact("readwrite", store => store.put(record)),
  get: id => transact("readonly", store => store.get(id)),
  list: () => transact("readonly", store => store.getAll()),
  delete: id => transact("readwrite", store => store.delete(id)),
};
