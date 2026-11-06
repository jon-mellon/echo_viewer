/** Bound remote and local lookups so the interface can offer a retry. */
export function boundedSplitLookup(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Saved variable lookup timed out")), 15000);
  })]).finally(() => clearTimeout(timer));
}
