import { validateGroupingSchema } from "./data_validation.mjs";
import { commitLocalSchema, urlSequence } from "./local_schema_store.mjs";
import { GROUPING_FORMAT_VERSION, GROUPING_MEMBERSHIP_UNIT } from "./app_contracts.mjs";

export const DRAFT_FORMAT = "echo-local-draft-v1";

export function makeDraftExport({ schema, url, basePublicationId, basePublicationHash = "" }) {
  validateGroupingSchema(schema);
  return {
    format: DRAFT_FORMAT, exportedAt: new Date().toISOString(),
    basePublicationId, basePublicationHash, url, schema: structuredClone(schema),
  };
}

export async function importDraftPayload(payload, location = globalThis.location) {
  if (payload?.format !== DRAFT_FORMAT || !payload.basePublicationId
    || typeof payload.url !== "string") throw new Error("Unsupported Echo draft export.");
  validateGroupingSchema(payload.schema);
  if (payload.schema.schema_version !== GROUPING_FORMAT_VERSION
    || payload.schema.membership_unit !== GROUPING_MEMBERSHIP_UNIT) {
    throw new Error("Unsupported draft schema format.");
  }
  const supplied = new URL(payload.url);
  if (supplied.searchParams.get("p") !== "1") throw new Error("Draft has no reconstruction instructions.");
  if (supplied.searchParams.get("schema") !== payload.basePublicationId) {
    throw new Error("Draft schema base does not match its URL.");
  }
  const id = crypto.randomUUID();
  const url = new URL(`${location.pathname}${supplied.search}${supplied.hash}`, location.origin);
  url.searchParams.set("local_schema", id);
  url.searchParams.set("schema", payload.basePublicationId);
  await commitLocalSchema({ id, expectedRevision: 0, schema: payload.schema,
    url: url.href, sequence: urlSequence(), basePublicationId: payload.basePublicationId,
    basePublicationHash: payload.basePublicationHash || null });
  return url.href;
}

export async function importDraftFile(file, location = globalThis.location) {
  const payload = JSON.parse(await file.text());
  return importDraftPayload(payload, location);
}
