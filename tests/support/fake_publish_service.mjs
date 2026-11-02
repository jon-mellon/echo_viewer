// An in-memory stand-in for the publishing service, following docs/publishing-api.md. It is not the real Worker (that lives in
// harvest_abstracts); it keeps just the behaviour the viewer's client relies on: owners behind a human check, reservations,
// create-only writes, finish checks, the static registry row, and reuse of an owner's earlier publication of the same content.
const PREFIX = "published-schemas/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hex = async text => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
  .map(byte => byte.toString(16).padStart(2, "0")).join("");
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const error = (status, code, message, extra = {}) => json({ error: code, message, ...extra }, status);

export function fakePublishService({ now = () => new Date("2026-11-01T12:00:00Z") } = {}) {
  const objects = new Map();   // bucket key -> { bytes, httpMetadata }
  const rows = new Map();      // publication id -> public row
  const uploads = new Map();   // publication id -> { owner, row, files }
  const splits = [];
  const sign = async owner => `${owner}.${await hex(`fake-secret:${owner}`)}`;
  const ownerOf = async request => {
    const token = request.headers.get("x-owner-token") || "";
    const [owner] = token.split(".");
    return UUID.test(owner || "") && token === await sign(owner) ? owner : null;
  };

  async function fetchImpl(input, init = {}) {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (request.method === "POST" && parts[1] === "owners") {
      const { turnstile } = await request.json();
      if (turnstile !== "good-token") return error(403, "turnstile_failed", "Could not verify that you are a person.");
      const owner = crypto.randomUUID();
      return json({ owner_id: owner, token: await sign(owner) }, 201);
    }
    if (request.method === "GET" && parts[1] === "splits") {
      const group = url.searchParams.get("group_id");
      return json(splits.filter(row => row.source_group_ids.includes(group)));
    }
    const owner = await ownerOf(request);
    if (!owner) return error(401, "owner_invalid", "The owner token is not valid.");
    if (request.method === "POST" && parts[1] === "publications" && parts.length === 2) {
      const body = await request.json();
      if (!UUID.test(body.publication_id || "") || !body.files?.some(file => file.path === "manifest.json")) return error(400, "bad_request", "Invalid publication.");
      const earlier = [...rows.values()].find(row => row.owner_id === owner && row.content_hash === body.content_hash && row.compiler_version === body.compiler_version);
      if (earlier) return json({ reused: true, row: earlier });
      if (rows.has(body.publication_id) || uploads.has(body.publication_id)) return error(409, "publication_exists", "That publication id is already in use.");
      const storage_prefix = `${owner}/${body.publication_id}`;
      const row = { id: body.publication_id, owner_id: owner, content_hash: body.content_hash, title: body.row.title,
        description: body.row.description ?? null, evidence_snapshot: body.row.evidence_snapshot ?? null, storage_prefix,
        parent_schema_id: body.row.parent_schema_id ?? null, compiled_manifest_path: body.row.compiled_manifest_path ?? null,
        compiled_manifest_hash: body.row.compiled_manifest_hash ?? null, compiler_version: body.compiler_version, created_at: now().toISOString() };
      uploads.set(body.publication_id, { owner, row, files: body.files });
      return json({ reused: false, publication_id: body.publication_id, storage_prefix }, 201);
    }
    const upload = uploads.get(parts[2]);
    if (!upload || upload.owner !== owner) return error(404, "no_upload", "No upload is open for this publication.");
    if (request.method === "PUT" && parts[3] === "files") {
      const path = decodeURIComponent(parts.slice(4).join("/"));
      const declared = upload.files.find(file => file.path === path);
      if (!declared) return error(403, "undeclared_file", "That file was not declared.");
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length !== declared.size) return error(400, "wrong_size", "The body was not the declared size.");
      const key = `${PREFIX}${upload.row.storage_prefix}/${path}`;
      if (objects.has(key)) return error(409, "exists", "That file has already been written.");
      objects.set(key, { bytes, httpMetadata: { cacheControl: "public, max-age=31536000, immutable" } });
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && parts[3] === "finish") {
      const folder = `${PREFIX}${upload.row.storage_prefix}/`;
      const missing = upload.files.filter(file => objects.get(folder + file.path)?.bytes.length !== file.size).map(file => file.path);
      if (missing.length) return error(409, "incomplete", "Some files are missing or the wrong size.", { missing });
      const registry = `${PREFIX}_registry/${upload.row.id}.json`;
      if (!objects.has(registry)) objects.set(registry, { bytes: new TextEncoder().encode(JSON.stringify(upload.row)),
        httpMetadata: { cacheControl: "public, max-age=31536000, immutable" } });
      rows.set(upload.row.id, upload.row);
      uploads.delete(upload.row.id);
      return json({ row: upload.row }, 201);
    }
    return error(404, "not_found", "Not found.");
  }

  return { fetchImpl, objects, rows, uploads, splits,
    addSplit: row => splits.push(row),
    /** The published files by their public address, as the viewer reads them. */
    readFetch: async url => {
      const object = objects.get(decodeURIComponent(String(url).replace("https://data.epistemicinfra.org/", "")));
      return object ? new Response(object.bytes) : new Response(null, { status: 404 });
    } };
}
