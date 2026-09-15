#!/usr/bin/env node
import { createHash } from "node:crypto";

const SUPABASE_URL = "https://xfsivvvmsgzbdnthupzg.supabase.co";
const BUCKET = "published-schemas";
const OLD_SNAPSHOT = "295d1e544255dacd869bfb09e8546cd020ace7b06a976280658e66c28af5f230";
const NEW_SNAPSHOT = "0cbb5b3bf27fbcde88e82cf5d810b8ad6c2cfbe9fdfea1b60be8f1e500a9b4ac";
const DAG_PATH = "compiled/browser-v2-dag.json";
const MANIFEST_PATH = "compiled/browser-v2-manifest.json";
const publications = [
  { id: "a0118906-2366-4cc8-8809-bafdf3860c23", prefix: "800234a1-9805-46df-8f2c-6019cf4cdc52/a0118906-2366-4cc8-8809-bafdf3860c23" },
  { id: "855d90f3-f93a-4dc8-9e72-4c4abe66c1f9", prefix: "800234a1-9805-46df-8f2c-6019cf4cdc52/855d90f3-f93a-4dc8-9e72-4c4abe66c1f9" },
  { id: "c7976c4b-b947-4e38-a52f-f85e401ba9f2", prefix: "ef630abd-82cf-40c9-8726-36ff3572edba/c7976c4b-b947-4e38-a52f-f85e401ba9f2" },
];

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const bytes = value => Buffer.from(JSON.stringify(stable(value)) + "\n");
const sha256 = value => createHash("sha256").update(value).digest("hex");
const publicUrl = (prefix, path) => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${prefix}/${path}`;

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return response.json();
}

async function uploadImmutable(prefix, path, body, serviceKey) {
  const existing = await fetch(publicUrl(prefix, path));
  if (existing.ok) {
    const current = Buffer.from(await existing.arrayBuffer());
    if (!current.equals(body)) throw new Error(`Refusing to replace differing object ${prefix}/${path}`);
    return "already present";
  }
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${prefix}/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, "content-type": "application/json" },
    body,
  });
  if (!response.ok) throw new Error(`Upload ${prefix}/${path}: HTTP ${response.status} ${await response.text()}`);
  return "uploaded";
}

const apply = process.argv.includes("--apply");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (apply && !serviceKey) throw new Error("Set SUPABASE_SERVICE_ROLE_KEY when using --apply.");

for (const publication of publications) {
  const oldDag = await getJson(publicUrl(publication.prefix, "compiled/dag.json"));
  const oldManifest = await getJson(publicUrl(publication.prefix, "compiled/manifest.json"));
  if (oldDag.evidence_snapshot !== OLD_SNAPSHOT || oldManifest.evidence_snapshot !== OLD_SNAPSHOT) {
    throw new Error(`Publication ${publication.id} is not bound to the expected source snapshot.`);
  }
  const dag = { ...oldDag, evidence_snapshot: NEW_SNAPSHOT };
  const dagBytes = bytes(dag);
  const manifest = { ...oldManifest, evidence_snapshot: NEW_SNAPSHOT,
    artifacts: { ...oldManifest.artifacts, dag: {
      path: DAG_PATH, sha256: sha256(dagBytes), bytes: dagBytes.length,
    } } };
  const manifestBytes = bytes(manifest);
  const result = { publication_id: publication.id, dag_sha256: sha256(dagBytes),
    manifest_sha256: sha256(manifestBytes), applied: apply };
  if (apply) {
    result.dag = await uploadImmutable(publication.prefix, DAG_PATH, dagBytes, serviceKey);
    result.manifest = await uploadImmutable(publication.prefix, MANIFEST_PATH, manifestBytes, serviceKey);
  }
  console.log(JSON.stringify(result));
}
