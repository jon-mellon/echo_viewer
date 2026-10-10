import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "../site/supabase_config.mjs";

const headers = { apikey: SUPABASE_PUBLISHABLE_KEY,
  Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}` };
const publications = [];
for (let offset = 0; ; offset += 1000) {
  const url = new URL("/rest/v1/published_schemas", SUPABASE_URL);
  url.searchParams.set("select", "id,storage_prefix,compiled_manifest_path");
  url.searchParams.set("limit", "1000");
  url.searchParams.set("offset", String(offset));
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Registry audit failed: HTTP ${response.status}`);
  const page = await response.json();
  publications.push(...page);
  if (page.length < 1000) break;
}

const leakingPublicationIds = [];
const inaccessiblePublicationIds = [];
const containsReasonField = value => Array.isArray(value)
  ? value.some(containsReasonField)
  : Boolean(value && typeof value === "object" && Object.entries(value)
    .some(([key, child]) => /reason/i.test(key) || containsReasonField(child)));
for (const publication of publications) {
  if (!publication.storage_prefix) { inaccessiblePublicationIds.push(publication.id); continue; }
  const path = `${publication.storage_prefix}/compiled/dag.json`
    .split("/").map(encodeURIComponent).join("/");
  const url = `${SUPABASE_URL}/storage/v1/object/public/published-schemas/${path}`;
  const response = await fetch(url);
  if (!response.ok) { inaccessiblePublicationIds.push(publication.id); continue; }
  const dag = await response.json();
  if ((dag.edges || []).some(containsReasonField)) leakingPublicationIds.push(publication.id);
}

console.log(JSON.stringify({ audited: publications.length - inaccessiblePublicationIds.length,
  leakingPublicationIds, inaccessiblePublicationIds }, null, 2));
if (leakingPublicationIds.length || inaccessiblePublicationIds.length) process.exitCode = 1;
