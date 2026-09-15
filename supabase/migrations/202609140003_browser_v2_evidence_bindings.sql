-- Run only after upload_browser_v2_compiled_artifacts.mjs --apply has placed
-- the immutable, re-bound artifacts. The DAG contents are unchanged; only the
-- evidence identity and artifact paths/hashes differ.
do $$
declare
  changed integer;
begin
  update public.published_schemas
  set evidence_snapshot = '0cbb5b3bf27fbcde88e82cf5d810b8ad6c2cfbe9fdfea1b60be8f1e500a9b4ac',
      compiled_manifest_path = 'compiled/browser-v2-manifest.json',
      compiled_manifest_hash = '4821b4f9ac6b6fc51434f09e3b8215f12e548e185513c3e6a5511aeefaf90728'
  where id = 'a0118906-2366-4cc8-8809-bafdf3860c23'
    and evidence_snapshot = '295d1e544255dacd869bfb09e8546cd020ace7b06a976280658e66c28af5f230'
    and compiled_manifest_hash = 'ac7f61f60faab5b4f3c53ff72ec47e048ed819f3303a1fe3b555a4c9e809a7cf';
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'Default publication was not in the expected pre-browser-v2 state'; end if;

  update public.published_schemas
  set evidence_snapshot = '0cbb5b3bf27fbcde88e82cf5d810b8ad6c2cfbe9fdfea1b60be8f1e500a9b4ac',
      compiled_manifest_path = 'compiled/browser-v2-manifest.json',
      compiled_manifest_hash = '3795d7b3718b04b00b54415948e29904570836f2bfa2f07b3b28f24c19e4efdd'
  where id = '855d90f3-f93a-4dc8-9e72-4c4abe66c1f9'
    and evidence_snapshot = '295d1e544255dacd869bfb09e8546cd020ace7b06a976280658e66c28af5f230'
    and compiled_manifest_hash = '451e405293db0fd7e07f410c619887eb879a7cc8d89136f4d1ef207d8b91d238';
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'First revised publication was not in the expected pre-browser-v2 state'; end if;

  update public.published_schemas
  set evidence_snapshot = '0cbb5b3bf27fbcde88e82cf5d810b8ad6c2cfbe9fdfea1b60be8f1e500a9b4ac',
      compiled_manifest_path = 'compiled/browser-v2-manifest.json',
      compiled_manifest_hash = '58dbb01b315ce930f0cd0fb4d40d60d1437a6a997af550b85b4dc02c14654b70'
  where id = 'c7976c4b-b947-4e38-a52f-f85e401ba9f2'
    and evidence_snapshot = '295d1e544255dacd869bfb09e8546cd020ace7b06a976280658e66c28af5f230'
    and compiled_manifest_hash = 'ca35a9efb5936ac91bcaf8948c6e3e2b3459b4db3711fcc224152792f7768c51';
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'Second revised publication was not in the expected pre-browser-v2 state'; end if;
end $$;
