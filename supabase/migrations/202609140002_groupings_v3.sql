-- Finalize the in-place groupings-v3 conversion after every replacement bundle
-- has been uploaded and hash-verified in Storage.
do $$
declare
  changed integer;
begin
  update public.published_schemas
  set content_hash = '0afd5f28c1b5456c47cfba84467bea1d62c6dc923a5851281a98d461f60066b4',
      compiled_manifest_path = 'compiled/manifest.json',
      compiled_manifest_hash = 'ac7f61f60faab5b4f3c53ff72ec47e048ed819f3303a1fe3b555a4c9e809a7cf',
      compiler_version = '1'
  where id = 'a0118906-2366-4cc8-8809-bafdf3860c23'
    and content_hash = '6732ed0bb2bce913c8b6611903f6c5d12ebccf3d5dc4f020887f5422515d7dfb';
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'Default publication was not in the expected pre-conversion state'; end if;

  update public.published_schemas
  set content_hash = '1d4da5a9e07c1dd899fa1bb94b5ef57909c0c679d8c2161d925ba7685c067bc8',
      compiled_manifest_path = 'compiled/manifest.json',
      compiled_manifest_hash = '451e405293db0fd7e07f410c619887eb879a7cc8d89136f4d1ef207d8b91d238',
      compiler_version = '1'
  where id = '855d90f3-f93a-4dc8-9e72-4c4abe66c1f9'
    and content_hash = '9522061620ea25392dfe6c86b07417f699f1b57dfabd813545cd06d30f4e268e';
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'First revised publication was not in the expected pre-conversion state'; end if;

  update public.published_schemas
  set content_hash = 'a15e4dfb1586e8ad59bfe0c19e8d5838ad060fc21eda0227e95ac1a0480ccd22',
      compiled_manifest_path = 'compiled/manifest.json',
      compiled_manifest_hash = 'ca35a9efb5936ac91bcaf8948c6e3e2b3459b4db3711fcc224152792f7768c51',
      compiler_version = '1'
  where id = 'c7976c4b-b947-4e38-a52f-f85e401ba9f2'
    and content_hash = 'dbfbf2193e74897ed0895ab5fe557ac44daec7cf5d242a3e8f113f191d033685';
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'Second revised publication was not in the expected pre-conversion state'; end if;

  -- This row was a storage-policy smoke test, not a valid schema bundle.
  delete from public.published_schemas
  where id = '39597a22-39ba-4d9c-8904-dd803220ab35'
    and content_hash = '9da59d0c557df0ef53fbeec274a48cc19ed90cca3d7ef145e924ae54497ccfea';
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'Invalid test publication was not in the expected state'; end if;
end $$;
