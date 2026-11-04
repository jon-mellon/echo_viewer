import { CLOUDFLARE_API_URL, cloudflareApiConfigured } from "./cloudflare_config.mjs";
import { getOwnPublications } from "./cloudflare_api.mjs";
import { publicSchemaBaseUrl } from "./publication_access.mjs";
import { loadGroupingSchemaStructure } from "./grouping_schema_loader.mjs";

export async function browsePublishedSplits(sourceGroupIds, _client = null,
  { apiUrl = CLOUDFLARE_API_URL, fetchImpl, storage } = {}) {
  if (!cloudflareApiConfigured(apiUrl)) throw new Error("Cloudflare publishing service is not configured.");
  const ids = [...new Set(sourceGroupIds)].filter(Boolean);
  if (!ids.length) return [];
  const pages = [];
  {
    const own = await getOwnPublications({ apiUrl, ...(fetchImpl ? { fetchImpl } : {}),
      ...(storage ? { storage } : {}) });
    const ownRows = await Promise.all(own.map(async publication => {
      const base = publicSchemaBaseUrl(null, publication.storage_prefix);
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

export async function loadPublishedSplitMembership(row, _client = null, fetchImpl = fetch) {
  const base = publicSchemaBaseUrl(null, row.storage_prefix);
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
