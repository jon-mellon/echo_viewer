export const PRODUCTION_EVIDENCE_MANIFEST =
  "https://data.epistemicinfra.org/evidence/layouts/browser-v2/99a8fd29ae81a1852ed181a62df01b989b99b536848bbf59f65a0ce8ea6871c0/manifest.json";
export const PRODUCTION_EVIDENCE_SNAPSHOT_BASE =
  "https://data.epistemicinfra.org/evidence/layouts/browser-v2/";

export const PRODUCTION_APP_ORIGIN = "https://echo.epistemicinfra.org";

export const DEFAULT_SCHEMA_PUBLICATION_ID = "f22dab8b-d9a7-4047-a775-0216b31c79fc";

/** Allow a deployment or shared link to select any ordinary static schema URL. */
export function groupingSchemaUrl(location = globalThis.location) {
  if (!location) return "";
  return new URL(location.href).searchParams.get("schema_url") || "";
}

export function schemaPublicationId(location = globalThis.location) {
  if (!location) return DEFAULT_SCHEMA_PUBLICATION_ID;
  const parameters = new URL(location.href).searchParams;
  if (parameters.has("schema_url")) return "";
  return parameters.get("schema") || DEFAULT_SCHEMA_PUBLICATION_ID;
}

export function isLocalDevelopment(location = globalThis.location) {
  return Boolean(location && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname));
}

/** Resolve immutable evidence snapshots on R2; local development may use an explicit manifest. */
export function evidenceManifestUrl(location = globalThis.location, evidenceSnapshot = "") {
  if (isLocalDevelopment(location)) {
    const override = new URL(location.href).searchParams.get("evidence_manifest");
    if (override) return new URL(override, location.origin).href;
  }
  // A permalink's explicit snapshot is the reproducibility contract. The
  // publication binding is only a fallback for shorter ?schema= links.
  let requested = (location ? new URL(location.href).searchParams.get("data_version") : "")
    || evidenceSnapshot
    || "";
  // Historical permalinks used the logical record signature instead of the
  // immutable directory ID. Resolve that alias independently of the default.
  if (requested === "5887939bf4e5d3619070a522f3ae11eee3f377c584bb8b2b3f77593c2b2248d4") {
    requested = "99a8fd29ae81a1852ed181a62df01b989b99b536848bbf59f65a0ce8ea6871c0";
  }
  if (requested === "11a8ec4f4868185d15dceae798d7617387eb9216c51a8f5acff4e84282b09acd") {
    requested = "f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b";
  }
  if (/^[0-9a-f]{64}$/i.test(requested)) {
    return `${PRODUCTION_EVIDENCE_SNAPSHOT_BASE}${requested.toLowerCase()}/manifest.json`;
  }
  return PRODUCTION_EVIDENCE_MANIFEST;
}

export function evidenceSnapshotIdFromManifestUrl(manifestUrl) {
  const match = String(manifestUrl || "").match(/\/(?:snapshots|layouts\/browser-v2)\/([0-9a-f]{64})\/manifest\.json(?:[?#]|$)/i);
  return match?.[1]?.toLowerCase() || "";
}
