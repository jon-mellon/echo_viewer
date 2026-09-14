export const PRODUCTION_EVIDENCE_MANIFEST =
  "https://data.epistemicinfra.org/evidence/snapshots/0cbb5b3bf27fbcde88e82cf5d810b8ad6c2cfbe9fdfea1b60be8f1e500a9b4ac/manifest.json";
export const PRODUCTION_EVIDENCE_SNAPSHOT_BASE =
  "https://data.epistemicinfra.org/evidence/snapshots/";

export const PRODUCTION_APP_ORIGIN = "https://echo.epistemicinfra.org";

export const DEFAULT_SCHEMA_PUBLICATION_ID = "a0118906-2366-4cc8-8809-bafdf3860c23";

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
  const requested = (location ? new URL(location.href).searchParams.get("data_version") : "")
    || evidenceSnapshot
    || "";
  if (/^[0-9a-f]{64}$/i.test(requested)) {
    return `${PRODUCTION_EVIDENCE_SNAPSHOT_BASE}${requested.toLowerCase()}/manifest.json`;
  }
  return PRODUCTION_EVIDENCE_MANIFEST;
}

export function evidenceSnapshotIdFromManifestUrl(manifestUrl) {
  const match = String(manifestUrl || "").match(/\/snapshots\/([0-9a-f]{64})\/manifest\.json(?:[?#]|$)/i);
  return match?.[1]?.toLowerCase() || "";
}
