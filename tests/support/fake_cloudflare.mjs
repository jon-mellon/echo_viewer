import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// A D1-shaped wrapper over real SQLite, so the worker's SQL and the migration run as written.
export function fakeD1(migrationPath = new URL("../../cloudflare/publish-worker/migrations/0001_init.sql", import.meta.url)) {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(migrationPath, "utf8"));
  const statement = (sql, params = []) => ({
    bind: (...next) => statement(sql, next),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => { db.prepare(sql).run(...params); return { success: true }; },
    _run: () => db.prepare(sql).run(...params),
  });
  return {
    prepare: sql => statement(sql),
    batch: async statements => {
      db.exec("begin");
      try { for (const item of statements) item._run(); db.exec("commit"); } catch (error) { db.exec("rollback"); throw error; }
      return statements.map(() => ({ success: true }));
    },
    exec: sql => db.exec(sql),
    raw: db,
  };
}

// An R2 bucket binding with the parts the worker uses: create-only put, list, delete.
export function fakeR2() {
  const objects = new Map();
  return {
    objects,
    async put(key, body, options = {}) {
      if (options.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { bytes, httpMetadata: options.httpMetadata });
      return { key, size: bytes.length };
    },
    async list({ prefix = "", limit = 1000, cursor } = {}) {
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
      const start = cursor ? keys.indexOf(cursor) + 1 : 0;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return { objects: page.map(key => ({ key, size: objects.get(key).bytes.length })), truncated, cursor: truncated ? page.at(-1) : undefined };
    },
    async delete(keys) { for (const key of [keys].flat()) objects.delete(key); },
  };
}
