# Publishing API (the contract the viewer relies on)

On a page that uses the Cloudflare schema source, the viewer publishes through a Worker and reads registry rows and
files from R2. The Worker, its database and its setup live outside this repo (in `harvest_abstracts`,
`analysis/10k/echo_viewer_bundle/publish_worker`). This is the contract the client in `site/cloudflare_api.mjs` depends
on; `tests/support/fake_publish_service.mjs` is a small in-memory stand-in that follows it, used by the client's tests.

Base address: `CLOUDFLARE_API_URL` in `site/cloudflare_config.mjs`. All bodies are JSON unless noted.

| Route | Auth | Request | Response |
|---|---|---|---|
| `POST /v1/owners` | Turnstile | `{ turnstile }` | `201 { owner_id, token }` (token is `<owner uuid>.<64 hex>`) |
| `POST /v1/publications` | `x-owner-token` | `{ publication_id, content_hash, compiler_version, row: { title, description, evidence_snapshot, parent_schema_id, compiled_manifest_path, compiled_manifest_hash }, files: [{ path, size }] }` | `201 { reused: false, publication_id, storage_prefix }`, or `200 { reused: true, row }` when the owner already published the same content |
| `PUT /v1/publications/:id/files/<path>` | `x-owner-token` | the file's bytes (`Content-Length` equals the declared size) | `204`; `403` if the file was not declared, `409` if it was already written |
| `POST /v1/publications/:id/finish` | `x-owner-token` | none | `201 { row }`; `409 { error: "incomplete", missing }` if a declared file is absent or the wrong size |
| `GET /v1/splits?group_id=…` | none | | approved split rows whose `source_group_ids` include the group |

Errors are `{ error, message }` with an HTTP status (`400` bad request, `401` owner, `403` Turnstile, `409`, `413`, `429`
rate limited, `507` storage full).

## Rules the client counts on
- **Create-only.** A file already written is never replaced and nothing is deleted by a client; `files` must include `manifest.json`.
- **Storage.** A publication's files are written under `published-schemas/<owner uuid>/<publication uuid>/<path>` in the bucket
  behind `https://data.epistemicinfra.org`, with `Cache-Control: public, max-age=31536000, immutable`.
- **Registry row as a static file.** When a publication finishes, its public row is also written, create-only, to
  `published-schemas/_registry/<publication uuid>.json`. The viewer reads this file (no Worker request). The row has
  `id, owner_id, content_hash, title, description, evidence_snapshot, storage_prefix, parent_schema_id,
  compiled_manifest_path, compiled_manifest_hash, compiler_version, created_at`; nothing else is public.
- **Owners.** The owner token identifies an anonymous browser (or agent); it is created once behind a Turnstile check and kept
  in local storage.
- **Integrity** is checked by the viewer when it reads: file bytes against the row's `content_hash`.
