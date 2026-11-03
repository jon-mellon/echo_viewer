import { supabase } from "./supabase_client.mjs";
import { schemaSource } from "./schema_source.mjs";
import { CLOUDFLARE_API_URL, cloudflareApiConfigured } from "./cloudflare_config.mjs";
import { getOwnPublications, getSplits } from "./cloudflare_api.mjs";
import { publicSchemaBaseUrl } from "./publication_access.mjs";
import { loadGroupingSchemaStructure } from "./grouping_schema_loader.mjs";

export async function browsePublishedSplits(sourceGroupIds, client = supabase,
  { source = schemaSource(), apiUrl = CLOUDFLARE_API_URL, fetchImpl, storage } = {}) {
  const viaWorker = source === "cloudflare" && cloudflareApiConfigured(apiUrl);
  if (!client && !viaWorker) throw new Error("Supabase is not configured.");
  const ids = [...new Set(sourceGroupIds)].filter(Boolean);
  if (!ids.length) return [];
  const pages = await Promise.all(ids.map(async id => {
    if (viaWorker) return getSplits(id, { apiUrl, ...(fetchImpl ? { fetchImpl } : {}) });
    const { data, error } = await client.from("published_split_index")
      .select("publication_id,group_id,split_id,source_group_ids,name,description,storage_prefix,membership_path,owner_id,published_at")
      .eq("quality_status", "approved").contains("source_group_ids", [id])
      .order("published_at", { ascending: false }).limit(100);
    if (error) throw error;
    return data || [];
  }));
  if (viaWorker) {
    const own = await getOwnPublications({ apiUrl, ...(fetchImpl ? { fetchImpl } : {}),
      ...(storage ? { storage } : {}) });
    const ownRows = await Promise.all(own.map(async publication => {
      const base = publicSchemaBaseUrl(client, publication.storage_prefix, "cloudflare");
      const staged = await loadGroupingSchemaStructure(base, fetchImpl || fetch);
      return staged.schema.groups.filter(group => group.source === "user_split"
        && group.provenance?.operation === "split_categories"
        && Array.isArray(group.provenance.source_group_ids)
        && staged.manifest.group_membership_files[group.group_id]).map(group => ({
          publication_id: publication.id, group_id: group.group_id,
          split_id: group.provenance.split_id || group.group_id,
          source_group_ids: group.provenance.source_group_ids,
          name: group.label, description: group.description,
          storage_prefix: publication.storage_prefix,
          membership_path: staged.manifest.group_membership_files[group.group_id],
          owner_id: publication.owner_id,
          published_at: publication.created_at, is_own: true,
        }));
    }));
    pages.push(ownRows.flat());
  }
  const unique = new Map();
  for (const row of pages.flat()) {
    if (row.source_group_ids?.length !== ids.length
      || !row.source_group_ids.every(id => ids.includes(id))) continue;
    const key = `${row.owner_id}:${row.split_id || row.group_id}`;
    if (!unique.has(key) || row.published_at > unique.get(key).published_at
      || row.published_at === unique.get(key).published_at && row.is_own) unique.set(key, row);
  }
  return [...unique.values()].sort((a, b) => b.published_at.localeCompare(a.published_at));
}

export async function loadPublishedSplitMembership(row, client = supabase, fetchImpl = fetch, source = schemaSource()) {
  if (!client && source !== "cloudflare") throw new Error("Supabase is not configured.");
  const base = publicSchemaBaseUrl(client, row.storage_prefix, source);
  const staged = await loadGroupingSchemaStructure(base, fetchImpl);
  if (staged.manifest.group_membership_files[row.group_id] !== row.membership_path) {
    throw new Error("The published split pointer no longer matches its schema.");
  }
  const group = staged.schema.groups.find(candidate => candidate.group_id === row.group_id);
  if (group?.source !== "user_split" || group.provenance?.operation !== "split_categories"
    || group.label !== row.name || group.description !== row.description) {
    throw new Error("The published split metadata no longer matches its schema.");
  }
  await staged.loadMemberships([row.group_id]);
  return group.variable_ids;
}
