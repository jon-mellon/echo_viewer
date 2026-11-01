-- Registry for Echo's published schemas, replacing the Supabase tables of the same names.
-- Rows are immutable once a publication finishes; only the worker writes them (the
-- split index is written by the scanner that ingests splits).
create table if not exists published_schemas (
  id text primary key,                 -- publication uuid
  owner_id text not null,              -- anonymous owner uuid issued by the worker
  content_hash text not null,
  title text not null,
  description text,
  evidence_snapshot text,
  storage_prefix text not null,        -- '<owner>/<publication>'
  parent_schema_id text,
  compiled_manifest_path text,
  compiled_manifest_hash text,
  compiler_version text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index if not exists published_schemas_owner_hash
  on published_schemas (owner_id, content_hash, compiler_version);

create table if not exists published_split_index (
  publication_id text not null references published_schemas(id) on delete cascade,
  group_id text not null,
  split_id text not null,
  source_group_ids text not null,      -- JSON array of group ids
  name text not null,
  description text not null,
  storage_prefix text not null,
  membership_path text not null,
  owner_id text not null,
  published_at text not null,
  quality_status text not null check (quality_status in ('approved', 'rejected')),
  quality_reason text,
  checked_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (publication_id, group_id)
);
create index if not exists published_split_index_recent
  on published_split_index (published_at desc) where quality_status = 'approved';

-- A publication being uploaded: what it may write, until it finishes or expires.
create table if not exists publication_uploads (
  id text primary key,
  owner_id text not null,
  content_hash text not null,
  row_json text not null,              -- the registry row to insert on finish
  files_json text not null,            -- [{ path, size }]
  expires_at integer not null          -- unix seconds
);
create index if not exists publication_uploads_expiry on publication_uploads (expires_at);

-- Fixed-window counters for rate limits (owner, address and global).
create table if not exists rate_counters (
  scope text not null,
  key text not null,
  window integer not null,             -- start of the window, unix seconds
  n integer not null,
  primary key (scope, key, window)
);
