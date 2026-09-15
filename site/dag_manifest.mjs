// @ts-check

/** @typedef {import("./app_contracts.mjs").EvidenceManifestFile} EvidenceManifestFile */

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * @param {Record<string, EvidenceManifestFile>} files
 * @returns {{relation: string, sqlIdentifier: string, file: EvidenceManifestFile}[]}
 */
export function manifestFileEntries(files) {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("Evidence manifest files must be an object.");
  }
  return Object.entries(files).map(([relation, file]) => {
    if (!SQL_IDENTIFIER.test(relation)) {
      throw new Error(`Invalid evidence relation name: ${JSON.stringify(relation)}.`);
    }
    if (!file || typeof file !== "object" || typeof file.url !== "string" || !file.url.trim()) {
      throw new Error(`Evidence relation ${relation} must specify a nonempty file URL.`);
    }
    return { relation, sqlIdentifier: `"${relation}"`, file };
  });
}

export const BROWSER_LAYOUT_VERSION = "browser-v2";

/** @param {Record<string, any>} manifest */
export function isBrowserV2Manifest(manifest) {
  return manifest?.layout_version === BROWSER_LAYOUT_VERSION;
}

/** Validate the immutable retrieval layout and return its URL patterns. */
/** @param {Record<string, any>} manifest */
export function browserV2ManifestLayout(manifest) {
  if (!isBrowserV2Manifest(manifest)) throw new Error(`Unsupported evidence layout: ${manifest?.layout_version || "missing"}.`);
  if (!/^[0-9a-f]{64}$/i.test(manifest.evidence_snapshot || "")) {
    throw new Error("Browser-v2 manifest has an invalid evidence_snapshot.");
  }
  if (!Number.isInteger(manifest.shards?.count) || manifest.shards.count < 1) {
    throw new Error("Browser-v2 manifest has an invalid shard count.");
  }
  if (manifest.lookup?.key !== "variable_index" || manifest.lookup?.value !== "shard_id") {
    throw new Error("Browser-v2 manifest has an unsupported lookup mapping.");
  }
  const paths = { lookup: manifest.lookup.path, ...manifest.shards };
  for (const key of ["lookup", "variables", "causal_links_by_source", "causal_links_by_target", "neighbors"]) {
    if (typeof paths[key] !== "string" || !paths[key].trim()) throw new Error(`Browser-v2 manifest is missing ${key}.`);
  }
  return paths;
}

/** Bind a physical browser layout to the logical evidence records used by a schema. */
/** @param {{manifest: Record<string, any>, manifestUrl: string, metadata: Record<string, any>, expectedRecordSignature: string}} input */
export function validateBrowserV2EvidenceBinding({ manifest, manifestUrl, metadata, expectedRecordSignature }) {
  const physicalId = String(manifestUrl || "").match(/\/layouts\/browser-v2\/([0-9a-f]{64})\/manifest\.json(?:[?#]|$)/i)?.[1]?.toLowerCase();
  if (physicalId && physicalId !== String(manifest?.evidence_snapshot || "").toLowerCase()) {
    throw new Error(`Browser-v2 manifest snapshot ${manifest?.evidence_snapshot || "(missing)"} does not match its URL snapshot ${physicalId}.`);
  }
  const recordSignature = metadata?.cache_compatibility?.record_signature || "";
  if (!expectedRecordSignature || recordSignature !== expectedRecordSignature) {
    throw new Error(`Browser-v2 evidence record signature ${recordSignature || "(missing)"} does not match the schema evidence record signature ${expectedRecordSignature || "(missing)"}.`);
  }
  return true;
}

/** @param {string} pattern @param {number} shardId */
export function browserV2ShardPath(pattern, shardId) {
  if (!Number.isInteger(shardId) || shardId < 0) throw new Error(`Invalid browser-v2 shard ID: ${shardId}.`);
  const match = pattern.match(/\{shard_id(?::0(\d+)d)?\}/);
  if (!match) throw new Error(`Invalid browser-v2 shard pattern: ${pattern}.`);
  return pattern.replace(match[0], String(shardId).padStart(Number(match[1] || 0), "0"));
}
