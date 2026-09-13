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
