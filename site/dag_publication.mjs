import { supabase } from "/supabase_client.mjs";
import { canonicalFolderHash, writeGroupingSchemaFolder } from "/grouping_schema_writer.mjs";
import { PUBLISHED_SCHEMA_BUCKET, publicationPermalink } from "/published_schema_loader.mjs";
import { ensureAnonymousPublicationUser } from "/dag_anonymous_auth.mjs";
import { setSafeUrl } from "/dom_builder.mjs";
import { createCompiledArtifacts, evidenceSnapshotForSchema, fullCompileDag,
  COMPILED_DAG_PATH, COMPILED_MANIFEST_PATH, DAG_COMPILER_VERSION } from "/compiled_dag.mjs";

export const CANONICAL_BASELINE_ID = "a0118906-2366-4cc8-8809-bafdf3860c23";
export const CANONICAL_BASELINE_HASH = "0afd5f28c1b5456c47cfba84467bea1d62c6dc923a5851281a98d461f60066b4";

export function formatSupabaseError(error) {
  if (!error) return "Unknown Supabase error";
  const parts = [error.message || String(error)];
  for (const key of ["code", "details", "hint", "status", "statusCode"]) {
    if (error[key] !== undefined && error[key] !== null && error[key] !== "") parts.push(`${key}: ${error[key]}`);
  }
  return parts.join(" | ");
}

function contentType(path) {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".yaml")) return "application/yaml";
  if (path.endsWith(".tsv")) return "text/tab-separated-values";
  return "application/octet-stream";
}

async function findOwnedPublication(client, ownerId, contentHash) {
  const { data, error } = await client.from("published_schemas")
    .select("id, owner_id, content_hash, storage_prefix, parent_schema_id, compiler_version, compiled_manifest_path")
    .eq("owner_id", ownerId)
    .eq("content_hash", contentHash)
    .eq("compiler_version", DAG_COMPILER_VERSION)
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

export async function canonicalizeWorkingSchema(schema, cryptoApi = globalThis.crypto) {
  const files = await writeGroupingSchemaFolder(schema, cryptoApi);
  return { files, contentHash: await canonicalFolderHash(files, cryptoApi) };
}

export async function publishWorkingSchema({
  schema,
  previousPublication,
  compiledDag = null,
  compileInput = null,
  client = supabase,
  cryptoApi = globalThis.crypto,
  onProgress = () => {},
}) {
  const user = await ensureAnonymousPublicationUser(client);
  const canonical = await canonicalizeWorkingSchema(schema, cryptoApi);
  const existing = await findOwnedPublication(client, user.id, canonical.contentHash);
  if (existing) return { ...existing, publicationId: existing.id, contentHash: existing.content_hash, reused: true };

  const publicationId = cryptoApi.randomUUID();
  const storagePrefix = `${user.id}/${publicationId}`;
  const evidenceSnapshot = evidenceSnapshotForSchema(schema);
  const dag = compiledDag || fullCompileDag({ schema, ...(compileInput || {}) });
  const compiled = await createCompiledArtifacts({ publicationId, schemaHash: canonical.contentHash,
    evidenceSnapshot, dag, cryptoApi });
  const files = new Map(canonical.files);
  files.set(COMPILED_DAG_PATH, compiled.dagBytes);
  files.set(COMPILED_MANIFEST_PATH, compiled.manifestBytes);
  const entries = [...files.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  for (const [index, [path, bytes]] of entries.entries()) {
    onProgress(index + 1, entries.length, path);
    const type = contentType(path);
    const { error } = await client.storage.from(PUBLISHED_SCHEMA_BUCKET).upload(
      `${storagePrefix}/${path}`, new Blob([bytes], { type }), { upsert: false, contentType: type },
    );
    if (error) throw error;
  }

  const parentSchemaId = previousPublication?.publication_id || CANONICAL_BASELINE_ID;
  const row = {
    id: publicationId,
    owner_id: user.id,
    content_hash: canonical.contentHash,
    title: schema.label || "Published grouping schema",
    description: schema.description || null,
    evidence_snapshot: evidenceSnapshot,
    storage_prefix: storagePrefix,
    parent_schema_id: parentSchemaId,
    compiled_manifest_path: COMPILED_MANIFEST_PATH,
    compiled_manifest_hash: await (async () => {
      const digest = await cryptoApi.subtle.digest("SHA-256", compiled.manifestBytes);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    })(),
    compiler_version: compiled.manifest.compiler_version,
  };
  const { error: insertError } = await client.from("published_schemas").insert(row);
  if (insertError) throw insertError;
  return {
    ...row,
    publicationId,
    contentHash: canonical.contentHash,
    fileCount: entries.length,
    reused: false,
  };
}

function showStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("publication-error", isError);
}

async function copyText(text, navigatorApi, windowApi) {
  if (navigatorApi.clipboard?.writeText) await navigatorApi.clipboard.writeText(text);
  else windowApi.prompt("Copy this permalink:", text);
}

export function createPublicationController({
  elements,
  getWorkingSchema,
  getPublicationState,
  getPermalinkState,
  setPublicationState,
  saveWorkingState,
  getCompiledDag = () => null,
  getCompileInput = () => null,
  canPublish = () => true,
  client = supabase,
  cryptoApi = globalThis.crypto,
  navigatorApi = globalThis.navigator,
  windowApi = globalThis.window,
}) {
  let busy = false;
  let statusRevision = 0;
  let statusTimer = null;
  let shareFeedbackTimer = null;

  async function currentCanonical() {
    return canonicalizeWorkingSchema(getWorkingSchema(), cryptoApi);
  }

  async function refreshAuthVisibility() {
    if (!client) {
      elements.publish.hidden = true;
      showStatus(elements.status, "Supabase publication is not configured.", true);
      return;
    }
    const { data, error } = await client.auth.getSession();
    elements.publish.hidden = false;
    elements.publish.title = data?.session?.user
      ? "Create an immutable public version"
      : "Create an immutable public version; publishing will start a private anonymous session";
    if (error) showStatus(elements.status, formatSupabaseError(error), true);
  }

  function stablePermalink(published) {
    return published?.publication_id
      ? publicationPermalink(published.publication_id, windowApi.location, getPermalinkState())
      : published?.permalink || null;
  }

  function renderPublicationState(published, hasLocalChanges = false) {
    const permalink = stablePermalink(published);
    elements.badge.textContent = !published?.publication_id
      ? "Private working copy"
      : hasLocalChanges ? "Public schema · Unpublished local changes" : "Public schema";
    elements.badge.classList.toggle("muted", !published?.publication_id);
    elements.badge.classList.toggle("warn", Boolean(published?.publication_id && hasLocalChanges));
    elements.permalink.hidden = !permalink;
    if (permalink) setSafeUrl(elements.permalink, "href", permalink);
  }

  async function refreshPublicationState() {
    const revision = ++statusRevision;
    const published = getPublicationState();
    if (!published?.publication_id || !published?.content_hash) {
      renderPublicationState(null);
      return;
    }
    try {
      const canonical = await currentCanonical();
      if (revision !== statusRevision) return;
      renderPublicationState(published, canonical.contentHash !== published.content_hash);
    } catch (error) {
      if (revision === statusRevision) renderPublicationState(published, true);
    }
  }

  function workingCopyChanged() {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => void refreshPublicationState(), 150);
  }

  function showShareCopied() {
    const button = elements.share;
    if (!button) return;
    clearTimeout(shareFeedbackTimer);
    button.textContent = "✓ Copied";
    button.classList.add("share-copied");
    button.setAttribute("aria-label", "View link copied to clipboard");
    shareFeedbackTimer = setTimeout(() => {
      button.textContent = "Share view";
      button.classList.remove("share-copied");
      button.removeAttribute("aria-label");
    }, 2400);
  }

  function confirmPublicPublication() {
    const dialog = elements.confirmation;
    if (!dialog?.showModal) {
      return Promise.resolve(windowApi.confirm("Publish this schema publicly?\n\nPublishing creates an immutable public version that anyone with the link can view and download. Your unpublished local edits remain private until you publish them."));
    }
    return new Promise(resolve => {
      const close = () => resolve(dialog.returnValue === "publish");
      dialog.addEventListener("close", close, { once: true });
      dialog.returnValue = "cancel";
      dialog.showModal();
    });
  }

  async function publish() {
    if (busy) return null;
    if (!canPublish()) {
      showStatus(elements.status, "Please wait for group memberships to finish loading before publishing.", true);
      return null;
    }
    busy = true;
    elements.publish.disabled = true;
    try {
      const canonical = await currentCanonical();
      const published = getPublicationState();
      if (canonical.contentHash === published?.content_hash) {
        renderPublicationState(published, false);
        showStatus(elements.status, "This working copy already matches the public version.");
        return published;
      }
      if (!await confirmPublicPublication()) return null;
      showStatus(elements.status, "Canonicalizing current working schema…");
      const result = await publishWorkingSchema({
        schema: getWorkingSchema(),
        previousPublication: getPublicationState(),
        compiledDag: getCompiledDag(),
        compileInput: await getCompileInput(),
        client,
        cryptoApi,
        onProgress: (current, total, path) => showStatus(elements.status, `Uploading ${current}/${total}: ${path}`),
      });
      const publication = {
        publication_id: result.publicationId,
        content_hash: result.contentHash,
        parent_publication_id: result.parent_schema_id,
        storage_prefix: result.storage_prefix,
        permalink: publicationPermalink(result.publicationId, windowApi.location, getPermalinkState()),
      };
      setPublicationState(publication);
      saveWorkingState();
      renderPublicationState(publication, false);
      showStatus(elements.status, result.reused
        ? `Already published as ${result.publicationId}. No files were uploaded.`
        : `Published ${result.fileCount} files as ${result.publicationId}.`);
      return publication;
    } catch (error) {
      const message = `Publish failed: ${formatSupabaseError(error)}`;
      showStatus(elements.status, message, true);
      console.error(message, error);
      return null;
    } finally {
      busy = false;
      elements.publish.disabled = !canPublish();
    }
  }

  async function share() {
    if (busy) return null;
    const published = getPublicationState();
    if (!published?.publication_id || !published?.content_hash) {
      showStatus(elements.status, "This schema is still private. Choose Publish publicly to create a public permalink.", true);
      elements.publish.focus();
      return null;
    }
    try {
      const canonical = await currentCanonical();
      const permalink = stablePermalink(published);
      if (canonical.contentHash !== published.content_hash) {
        await copyText(permalink, navigatorApi, windowApi);
        showShareCopied();
        renderPublicationState(published, true);
        showStatus(elements.status, "Copied a view permalink using the last published schema. Your current schema edits are still private. Choose Publish publicly to include them in shared views.");
        elements.publish.focus();
        return permalink;
      }
      await copyText(permalink, navigatorApi, windowApi);
      showShareCopied();
      renderPublicationState(published, false);
      showStatus(elements.status, "Copied a permalink to this view of the public schema.");
      return permalink;
    } catch (error) {
      const message = `Could not share: ${formatSupabaseError(error)}`;
      showStatus(elements.status, message, true);
      console.error(message, error);
      return null;
    }
  }

  function initialize() {
    elements.publish.addEventListener("click", publish);
    if (client) client.auth.onAuthStateChange(() => setTimeout(() => void refreshAuthVisibility(), 0));
    const published = getPublicationState();
    if (published?.publication_id) {
      showStatus(elements.status, "Loaded the public schema. Further edits remain private and local until you publish them.");
    }
    void refreshPublicationState();
    void refreshAuthVisibility();
  }

  function setSchemaReady(ready) {
    elements.publish.disabled = !ready || busy;
    if (!ready) showStatus(elements.status, "Loading group memberships… Editing and publishing will unlock when ready.");
  }

  function setSchemaLoadFailed() {
    elements.publish.disabled = true;
    showStatus(elements.status, "Group memberships could not be verified. Editing and publishing remain disabled.", true);
  }

  return { initialize, publish, share, currentCanonical, refreshAuthVisibility, refreshPublicationState, workingCopyChanged, setSchemaReady, setSchemaLoadFailed };
}
