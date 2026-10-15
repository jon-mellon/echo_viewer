import { supabase } from "/supabase_client.mjs";
import { publicationPermalink } from "/published_schema_loader.mjs";
import { setSafeUrl } from "/dom_builder.mjs";
import { canonicalizeWorkingSchema, publishWorkingSchema, formatSupabaseError } from "./dag_publication_core.mjs";
export { CANONICAL_BASELINE_ID, CANONICAL_BASELINE_HASH, canonicalizeWorkingSchema, publishWorkingSchema, formatSupabaseError } from "./dag_publication_core.mjs";

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
  const initialPublication = getPublicationState();
  let hasPublishableChanges = !(initialPublication?.publication_id && initialPublication?.content_hash);

  function refreshPublishVisibility() {
    elements.publish.hidden = !client || !hasPublishableChanges;
    elements.publish.disabled = busy || !canPublish();
  }

  async function currentCanonical() {
    return canonicalizeWorkingSchema(getWorkingSchema(), cryptoApi);
  }

  async function refreshAuthVisibility() {
    if (!client) {
      refreshPublishVisibility();
      showStatus(elements.status, "Supabase publication is not configured.", true);
      return;
    }
    const { data, error } = await client.auth.getSession();
    refreshPublishVisibility();
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
    hasPublishableChanges = !published?.publication_id || hasLocalChanges;
    refreshPublishVisibility();
    elements.badge.textContent = !published?.publication_id
      ? "Private working copy"
      : hasLocalChanges ? "Public schema · Unpublished local changes" : "Public schema";
    elements.badge.classList.toggle("muted", !published?.publication_id);
    elements.badge.classList.toggle("warn", Boolean(published?.publication_id && hasLocalChanges));
    elements.permalink.hidden = !permalink || hasLocalChanges;
    if (permalink && !hasLocalChanges) setSafeUrl(elements.permalink, "href", permalink);
    else elements.permalink.removeAttribute("href");
  }

  async function refreshPublicationState() {
    if (!canPublish()) return;
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
    // Invalidate a hash comparison started before this edit. Its stale result
    // must not hide the publish action after a new exclusion.
    statusRevision += 1;
    hasPublishableChanges = true;
    refreshPublishVisibility();
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
    const resolved = await publicPermalink();
    if (!resolved) return null;
    const { permalink } = resolved;
    try {
      await copyText(permalink, navigatorApi, windowApi);
      showShareCopied();
      showStatus(elements.status, "Copied a permalink to this view of the public schema.");
      return permalink;
    } catch (error) {
      const message = `Could not share: ${formatSupabaseError(error)}`;
      showStatus(elements.status, message, true);
      console.error(message, error);
      return null;
    }
  }

  async function publicPermalink() {
    const published = getPublicationState();
    if (!published?.publication_id || !published?.content_hash) {
      showStatus(elements.status, "This schema is still private. Choose Publish publicly to create a public permalink.", true);
      elements.publish.focus();
      return null;
    }
    try {
      const canonical = await currentCanonical();
      const permalink = stablePermalink(published);
      const hasLocalChanges = canonical.contentHash !== published.content_hash;
      renderPublicationState(published, hasLocalChanges);
      if (hasLocalChanges) {
        showStatus(elements.status, "This schema has unpublished changes. Publish them before creating a permalink.", true);
        elements.publish.focus();
        return null;
      }
      return { permalink, hasLocalChanges: false };
    } catch (error) {
      const message = `Could not create a public permalink: ${formatSupabaseError(error)}`;
      showStatus(elements.status, message, true);
      console.error(message, error);
      return null;
    }
  }

  function initialize() {
    elements.publish.addEventListener("click", publish);
    if (client) client.auth.onAuthStateChange(() => setTimeout(() => void refreshAuthVisibility(), 0));
    const published = getPublicationState();
    hasPublishableChanges = !published?.publication_id;
    refreshPublishVisibility();
    if (published?.publication_id) {
      elements.badge.textContent = "Public schema";
      elements.badge.classList.remove("muted", "warn");
      const currentUrl = new URL(windowApi.location.href);
      if (currentUrl.searchParams.get("schema") === published.publication_id) {
        setSafeUrl(elements.permalink, "href", currentUrl.href);
        elements.permalink.hidden = false;
      }
      if (canPublish()) {
        showStatus(elements.status, "Loaded the public schema. Further edits remain private and local until you publish them.");
      }
    }
    if (canPublish()) void refreshPublicationState();
    void refreshAuthVisibility();
  }

  function setSchemaReady(ready) {
    elements.publish.disabled = !ready || busy;
    if (!ready) showStatus(elements.status, "Loading group memberships… Editing and publishing will unlock when ready.");
    else showStatus(elements.status, "Loaded the public schema. Editing and publishing are ready.");
  }

  function setSchemaLoadFailed() {
    elements.publish.disabled = true;
    showStatus(elements.status, "Group memberships could not be verified. Editing and publishing remain disabled.", true);
  }

  return { initialize, publish, share, publicPermalink, currentCanonical, refreshAuthVisibility, refreshPublicationState, workingCopyChanged, setSchemaReady, setSchemaLoadFailed };
}
