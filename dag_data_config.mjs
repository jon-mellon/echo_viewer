export const PRODUCTION_EVIDENCE_MANIFEST =
  "https://data.epistemicinfra.org/evidence/snapshots/0cbb5b3bf27fbcde88e82cf5d810b8ad6c2cfbe9fdfea1b60be8f1e500a9b4ac/manifest.json";

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

export function evidenceManifestUrl() {
  return PRODUCTION_EVIDENCE_MANIFEST;
}
