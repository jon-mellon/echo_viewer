-- Registry pointers only. Aggregate rows remain in immutable Storage objects.
alter table public.published_schemas
  add column if not exists compiled_manifest_path text,
  add column if not exists compiled_manifest_hash text,
  add column if not exists compiler_version text;

comment on column public.published_schemas.compiled_manifest_path is
  'Relative path to the immutable compiled manifest in the publication Storage prefix.';
