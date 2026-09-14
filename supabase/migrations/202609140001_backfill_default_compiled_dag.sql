do $$
declare
  updated_rows integer;
begin
  update public.published_schemas
  set compiled_manifest_path = 'compiled/manifest.json',
      compiled_manifest_hash = 'd7232865b87cf77ddf9ed6facab452ac5da0c53b10a265c9dfed8dfd367ec53e',
      compiler_version = '1'
  where id = 'a0118906-2366-4cc8-8809-bafdf3860c23'
    and content_hash = '6732ed0bb2bce913c8b6611903f6c5d12ebccf3d5dc4f020887f5422515d7dfb'
    and evidence_snapshot = '295d1e544255dacd869bfb09e8546cd020ace7b06a976280658e66c28af5f230'
    and compiled_manifest_path is null
    and compiled_manifest_hash is null
    and compiler_version is null;

  get diagnostics updated_rows = row_count;
  if updated_rows <> 1 then
    raise exception 'Expected to finalize exactly one untouched default publication, updated %', updated_rows;
  end if;
end
$$;
