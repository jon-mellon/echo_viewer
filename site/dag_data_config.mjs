export const PRODUCTION_EVIDENCE_MANIFEST =
  "https://data.epistemicinfra.org/evidence/snapshots/0cbb5b3bf27fbcde88e82cf5d810b8ad6c2cfbe9fdfea1b60be8f1e500a9b4ac/manifest.json";

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

/** A local URL may opt into another snapshot; deployed builds always use R2. */
export function evidenceManifestUrl(location = globalThis.location) {
  if (isLocalDevelopment(location)) {
    const override = new URL(location.href).searchParams.get("evidence_manifest");
    if (override) return new URL(override, location.origin).href;
  }
  return PRODUCTION_EVIDENCE_MANIFEST;
}
