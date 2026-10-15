import { supabase } from "./supabase_client.mjs";
import { publicSchemaBaseUrl } from "./publication_access.mjs";
import { loadGroupingSchemaStructure } from "./grouping_schema_loader.mjs";

export async function browsePublishedSplits(sourceGroupIds, client = supabase) {
  if (!client) throw new Error("Supabase is not configured.");
  const ids = [...new Set(sourceGroupIds)].filter(Boolean);
  if (!ids.length) return [];
  const pages = await Promise.all(ids.map(async id => {
    const { data, error } = await client.from("published_split_index")
      .select("publication_id,group_id,split_id,source_group_ids,name,description,storage_prefix,membership_path,owner_id,published_at")
      .eq("quality_status", "approved").contains("source_group_ids", [id])
      .order("published_at", { ascending: false }).limit(100);
    if (error) throw error;
    return data || [];
  }));
  const unique = new Map();
  for (const row of pages.flat()) {
    if (row.source_group_ids?.length !== ids.length
      || !row.source_group_ids.every(id => ids.includes(id))) continue;
    const key = `${row.owner_id}:${row.split_id || row.group_id}`;
    if (!unique.has(key) || row.published_at > unique.get(key).published_at) unique.set(key, row);
  }
  return [...unique.values()].sort((a, b) => b.published_at.localeCompare(a.published_at));
}

export async function loadPublishedSplitMembership(row, client = supabase, fetchImpl = fetch) {
  if (!client) throw new Error("Supabase is not configured.");
  const base = publicSchemaBaseUrl(client, row.storage_prefix);
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
