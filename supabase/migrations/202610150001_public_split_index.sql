-- Discoverable metadata for splits in immutable published schema bundles.
-- The service worker that scans publications is the sole writer. Memberships
-- remain in Storage and are fetched only when a user chooses a split.
create table if not exists public.published_split_index (
  publication_id uuid not null references public.published_schemas(id) on delete cascade,
  group_id text not null,
  split_id text not null,
  source_group_ids text[] not null,
  name text not null,
  description text not null,
  storage_prefix text not null,
  membership_path text not null,
  owner_id uuid not null,
  published_at timestamptz not null,
  quality_status text not null check (quality_status in ('approved', 'rejected')),
  quality_reason text,
  checked_at timestamptz not null default now(),
  primary key (publication_id, group_id),
  constraint description_minimum check (quality_status <> 'approved' or char_length(btrim(description)) >= 20),
  constraint name_nonempty check (quality_status <> 'approved' or char_length(btrim(name)) > 0)
);

create index if not exists published_split_index_browse
  on public.published_split_index using gin (source_group_ids)
  where quality_status = 'approved';
create index if not exists published_split_index_recent
  on public.published_split_index (published_at desc)
  where quality_status = 'approved';

alter table public.published_split_index enable row level security;
grant select on public.published_split_index to anon, authenticated;
grant all on public.published_split_index to service_role;
create policy "Anyone may browse approved split metadata"
  on public.published_split_index for select to anon, authenticated
  using (quality_status = 'approved');
-- No client insert/update/delete policy: ingestion requires a service role key.
