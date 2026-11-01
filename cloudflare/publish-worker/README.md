# Echo publishing API (Cloudflare Worker)

Anonymous publishing without Supabase: files go into the R2 bucket behind
`data.epistemicinfra.org` under `published-schemas/`, and the schema registry lives in D1.
Reads of the files stay on `https://data.epistemicinfra.org/published-schemas/...`.

| Route | Who | What |
|---|---|---|
| `POST /v1/owners` | anyone with a Turnstile token | issues an anonymous owner id and token |
| `POST /v1/publications` | owner | reserves a publication and the exact files it may write (or returns the owner's earlier publication of the same content) |
| `PUT /v1/publications/:id/files/*` | owner | writes one declared file, **create-only** (a written file is never replaced) |
| `POST /v1/publications/:id/finish` | owner | checks every declared file is present at its size, then registers the publication |
| `GET /v1/schemas/:id` | anyone | the registry row |
| `GET /v1/splits?group_id=…` | anyone | approved splits that include a source group |

Clients cannot delete or replace anything. Limits (in `src/index.mjs`): 500 files, 25 MB a file,
120 MB a publication, 30 publications per owner and 60 per address per day, 500 a day overall,
20 new owners per address per hour. An hourly cron deletes the files of uploads that never
finished. The viewer checks content hashes when it reads, so the worker bounds what can be
written and does not recompute the hash.

## One-time setup

Needs a Cloudflare login (`npx wrangler login`); nothing here is secret.

```bash
cd cloudflare/publish-worker
npx wrangler d1 create echo-registry          # put the printed database_id in wrangler.toml
npx wrangler d1 migrations apply echo-registry --remote
npx wrangler secret put OWNER_SECRET          # any long random string: openssl rand -hex 32
npx wrangler secret put TURNSTILE_SECRET      # from a Turnstile widget (dashboard > Turnstile)
npx wrangler deploy
```

Then in the dashboard give the worker a custom domain such as `echo-api.epistemicinfra.org`
(Workers & Pages > echo-publish > Settings > Domains & Routes). The Turnstile **site key** is
public and goes in the viewer's config. The bucket binding needs no S3 keys.

Load the existing registry (31 publications and their approved splits) from Supabase:

```bash
node scripts/export_registry_sql.mjs > registry.sql
npx wrangler d1 execute echo-registry --remote --file registry.sql
curl https://echo-api.epistemicinfra.org/v1/schemas/0d7bdf95-3f02-4e72-8629-e6d456434ad5
```

The load is `insert or ignore`, so it can be repeated. Files already in R2 come from
`mirror_published_schemas_r2.py` (harvest_abstracts).

## Tests

`npm run test:graph` runs `tests/publish_worker.test.mjs` against fake R2 and a real SQLite
engine (Node's `node:sqlite`) loaded with the migration.
