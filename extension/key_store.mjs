// Keys stay out of web-origin storage, sync, captures and review checkpoints.
// Session storage survives panel/service-worker recreation without writing to disk.
// Persistent storage is an explicit first-connection option, not encryption.
export function createKeyStore(storage) {
  const name = "echo-openrouter-key-v1";
  const ready = Promise.all([storage.session, storage.local].map(area => area.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })));
  return {
    async read() {
      await ready;
      const session = (await storage.session.get(name))[name];
      const local = (await storage.local.get(name))[name];
      return { key: session || local || null, persistent: Boolean(local) };
    },
    async save(key, persistent = false) {
      await ready;
      if (typeof key !== "string" || !key.trim() || key.length > 2048) throw new Error("Invalid connection key.");
      if (persistent) await storage.local.set({ [name]: key });
      else await storage.local.remove(name);
      await storage.session.set({ [name]: key });
    },
    async forget() {
      await ready;
      await Promise.all([storage.session, storage.local].map(area => area.remove(name)));
    }
  };
}
