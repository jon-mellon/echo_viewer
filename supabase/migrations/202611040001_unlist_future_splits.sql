-- Preserve discovery for publications that already existed when public listing ended.
-- New schemas remain public by direct link but their splits cannot be listed by anon clients.
alter table public.published_schemas enable row level security;

-- Existing broad SELECT policies cannot bypass a restrictive policy. Publishers may
-- still inspect their own rows for deduplication; other users can only list old rows.
create policy "List existing or owned published schemas"
  on public.published_schemas for select to anon, authenticated
  using (created_at < timestamptz '2026-11-04T00:16:28Z' or owner_id = (select auth.uid()));
create policy "Restrict new published schema listing"
  as restrictive on public.published_schemas for select to anon, authenticated
  using (created_at < timestamptz '2026-11-04T00:16:28Z' or owner_id = (select auth.uid()));

-- A direct link supplies the unguessable publication UUID. This function returns
-- exactly that public row, without granting the caller a way to enumerate rows.
create function public.lookup_published_schema(publication_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', s.id, 'owner_id', s.owner_id, 'content_hash', s.content_hash,
    'storage_prefix', s.storage_prefix, 'parent_schema_id', s.parent_schema_id,
    'title', s.title, 'description', s.description, 'evidence_snapshot', s.evidence_snapshot,
    'compiled_manifest_path', s.compiled_manifest_path, 'compiled_manifest_hash', s.compiled_manifest_hash,
    'compiler_version', s.compiler_version, 'created_at', s.created_at)
  from public.published_schemas s where s.id = publication_id limit 1;
$$;
revoke all on function public.lookup_published_schema(uuid) from public;
grant execute on function public.lookup_published_schema(uuid) to anon, authenticated;

-- Public object URLs remain readable, while Storage listing cannot reveal their keys.
create policy "Do not enumerate published schema objects"
  as restrictive on storage.objects for select to anon, authenticated
  using (bucket_id <> 'published-schemas' or not storage.allow_only_operation('object.list'));

drop policy if exists "Anyone may browse approved split metadata" on public.published_split_index;
create policy "Anyone may browse approved legacy split metadata"
  on public.published_split_index for select to anon, authenticated
  using (quality_status = 'approved' and published_at < timestamptz '2026-11-04T00:16:28Z');
create policy "Restrict future split listing"
  as restrictive on public.published_split_index for select to anon, authenticated
  using (quality_status = 'approved' and published_at < timestamptz '2026-11-04T00:16:28Z');
