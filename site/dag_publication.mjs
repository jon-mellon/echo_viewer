import { publicationPermalink } from "/published_schema_loader.mjs";
import { canonicalizeWorkingSchema, publishWorkingSchema, formatPublicationError, workingSchemaHashes } from "./dag_publication_core.mjs";
import { confirmPublicPublication } from "./publication_consent.mjs";
export { CANONICAL_BASELINE_ID, CANONICAL_BASELINE_HASH, canonicalizeWorkingSchema, publishWorkingSchema, formatPublicationError } from "./dag_publication_core.mjs";

function showStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("publication-error", isError);
}

// Publication status shown in the Schema menu's badge. It is derived from the
// stored publication and a hash comparison, never from fixed text.
export const PUBLICATION_STATUS = Object.freeze({
  draft: { label: "Local draft", tone: "muted", title: "This schema has never been published" },
  changed: { label: "Unpublished changes", tone: "warn", title: "Your local edits differ from the public version" },
  published: { label: "Published", tone: "", title: "Your working copy matches the public version" },
});

export function publicationStatus(published, hasLocalChanges = false) {
  if (!published?.publication_id) return PUBLICATION_STATUS.draft;
  return hasLocalChanges ? PUBLICATION_STATUS.changed : PUBLICATION_STATUS.published;
}

async function copyText(text, navigatorApi, windowApi) {
  if (navigatorApi.clipboard?.writeText) {
    try {
      await navigatorApi.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard access can expire while the schema is being validated on mobile.
    }
  }
  windowApi.prompt("Copy this permalink:", text);
  return false;
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
  publishSchema = publishWorkingSchema,
  // Temporary notification for completed operations, which do not belong in the menu.
  notify = () => {},
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

  function publishTitle() {
    if (busy) return "Publishing…";
    if (!canPublish()) return "Publishing is unavailable while the schema is loading or a group edit is unsaved";
    return "Create an immutable public version";
  }

  function refreshPublishVisibility() {
    elements.publish.hidden = !hasPublishableChanges;
    elements.publish.disabled = busy || !canPublish();
    elements.publish.title = publishTitle();
  }

  function setBadge(status) {
    elements.badge.textContent = status.label;
    elements.badge.title = status.title;
    elements.badge.classList.toggle("muted", status.tone === "muted");
    elements.badge.classList.toggle("warn", status.tone === "warn");
    // A dot on the Schema button says there is something to publish without opening the menu.
    elements.menuButton?.classList.toggle("has-unpublished", status.tone === "warn");
    if (elements.menuButton) elements.menuButton.title = status.tone === "warn" ? `Schema · ${status.label}` : "Schema";
  }

  // Errors and progress stay in the menu until replaced; completed operations
  // are announced once and leave the menu clear.
  function clearStatus() { showStatus(elements.status, ""); }
  function reportSuccess(message) {
    clearStatus();
    notify(message);
  }

  async function currentCanonical() {
    return canonicalizeWorkingSchema(getWorkingSchema(), cryptoApi);
  }

  // A publication made before the derived view files existed hashes without them.
  async function matchesPublished(published) {
    const hash = published?.content_hash;
    if (!hash) return false;
    const start = performance.now();
    try {
      return (await workingSchemaHashes(getWorkingSchema(), cryptoApi)).includes(hash);
    } finally {
      performance.measure("echo:publication:compare", { start, end: performance.now() });
    }
  }

  function stablePermalink(published) {
    return published?.publication_id
      ? publicationPermalink(published.publication_id, windowApi.location, getPermalinkState())
      : published?.permalink || null;
  }

  function renderPublicationState(published, hasLocalChanges = false) {
    hasPublishableChanges = !published?.publication_id || hasLocalChanges;
    refreshPublishVisibility();
    setBadge(publicationStatus(published, hasLocalChanges));
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
      const matches = await matchesPublished(published);
      if (revision !== statusRevision) return;
      renderPublicationState(published, !matches);
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
    button.classList.add("share-copied");
    button.setAttribute("aria-label", "Copied");
    button.title = "Link copied";
    shareFeedbackTimer = setTimeout(() => {
      button.classList.remove("share-copied");
      button.setAttribute("aria-label", "Share view");
      button.title = "Copy a link to this view";
    }, 2400);
  }

  async function publish() {
    if (busy) return null;
    if (!canPublish()) {
      showStatus(elements.status, "Please wait for group memberships to finish loading before publishing.", true);
      return null;
    }
    busy = true;
    refreshPublishVisibility();
    try {
      const published = getPublicationState();
      const comparisonRevision = statusRevision;
      if (await matchesPublished(published) && comparisonRevision === statusRevision) {
        renderPublicationState(published, false);
        reportSuccess("Already published: this working copy matches the public version.");
        return published;
      }
      if (!await confirmPublicPublication(elements.confirmation, windowApi)) return null;
      showStatus(elements.status, "Canonicalizing current working schema…");
      const schema = structuredClone(getWorkingSchema());
      const preparationRevision = statusRevision;
      const compiledDag = getCompiledDag();
      const compileInput = await getCompileInput();
      if (preparationRevision !== statusRevision || JSON.stringify(schema) !== JSON.stringify(getWorkingSchema())) {
        throw new Error("The working copy changed while preparing publication. Please try again.");
      }
      const result = await publishSchema({
        schema,
        previousPublication: getPublicationState(),
        compiledDag,
        compileInput,
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
      // The user may have edited the working copy while the upload ran.
      // Stay conservative until a fresh comparison of the current copy finishes.
      renderPublicationState(publication, true);
      await refreshPublicationState();
      reportSuccess(result.reused
        ? `Already published as ${result.publicationId}. No files were uploaded.`
        : `Published ${result.fileCount} files as ${result.publicationId}.`);
      return publication;
    } catch (error) {
      const message = `Publish failed: ${formatPublicationError(error)}`;
      showStatus(elements.status, message, true);
      console.error(message, error);
      return null;
    } finally {
      busy = false;
      refreshPublishVisibility();
    }
  }

  async function share() {
    if (busy) return null;
    const resolving = publicPermalink();
    // Safari requires clipboard.write to start in the tap handler. Its promised
    // data lets the schema validation finish before any link is copied.
    let pendingCopy = null;
    if (navigatorApi.clipboard?.write && windowApi.ClipboardItem) {
      try {
        const data = resolving.then(result => {
          if (!result) throw new Error("View is not shareable");
          return new Blob([result.permalink], { type: "text/plain" });
        });
        pendingCopy = navigatorApi.clipboard.write([new windowApi.ClipboardItem({ "text/plain": data })]);
        pendingCopy.catch(() => {});
      } catch { /* Fall back to writeText and the copy dialog. */ }
    }
    const resolved = await resolving;
    if (!resolved) return null;
    const { permalink } = resolved;
    try {
      let copied = false;
      if (pendingCopy) {
        try { await pendingCopy; copied = true; } catch { /* Try the fallback. */ }
      }
      if (!copied) copied = await copyText(permalink, navigatorApi, windowApi);
      if (copied) {
        showShareCopied();
        reportSuccess("Copied a permalink to this view of the public schema.");
      } else {
        clearStatus();
      }
      return permalink;
    } catch (error) {
      const message = `Could not share: ${formatPublicationError(error)}`;
      showStatus(elements.status, message, true);
      console.error(message, error);
      return null;
    }
  }

  // Warn that the public version lacks the current view and offer to publish it first.
  function confirmPublishBeforeShare(neverPublished) {
    const dialog = elements.shareWarning;
    const detail = neverPublished
      ? "This schema is unpublished, so there is no public link to share yet."
      : "This schema has unpublished changes, so a shared link would not show your latest edits.";
    if (!dialog?.showModal) {
      return Promise.resolve(windowApi.confirm(`${detail}\n\nPublish it now?`));
    }
    const message = dialog.querySelector("[data-share-warning-message]");
    if (message) message.textContent = detail;
    return new Promise(resolve => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "publish"), { once: true });
      dialog.returnValue = "cancel";
      dialog.showModal();
    });
  }

  async function publicPermalink() {
    let published = getPublicationState();
    const neverPublished = !published?.publication_id || !published?.content_hash;
    try {
      let hasLocalChanges = neverPublished;
      if (!neverPublished) {
        hasLocalChanges = !await matchesPublished(published);
        renderPublicationState(published, hasLocalChanges);
      }
      if (hasLocalChanges) {
        if (!await confirmPublishBeforeShare(neverPublished)) return null;
        published = await publish();
        if (!published?.publication_id) return null;
      }
      // An edit can finish while a publication or hash comparison is in flight.
      // Never present the older publication as a link to the current working copy.
      const revision = statusRevision;
      if (!await matchesPublished(published) || revision !== statusRevision) {
        showStatus(elements.status, "The working copy changed while sharing. Publish the latest changes and try again.", true);
        return null;
      }
      return { permalink: stablePermalink(published), hasLocalChanges: false };
    } catch (error) {
      const message = `Could not create a public permalink: ${formatPublicationError(error)}`;
      showStatus(elements.status, message, true);
      console.error(message, error);
      return null;
    }
  }

  function initialize() {
    elements.publish.addEventListener("click", publish);
    const published = getPublicationState();
    hasPublishableChanges = !published?.publication_id;
    refreshPublishVisibility();
    if (published?.publication_id) {
      // Until the hash comparison finishes, assume the copy matches what was loaded.
      setBadge(publicationStatus(published, false));
    }
    if (canPublish()) void refreshPublicationState();
  }

  function setSchemaReady(ready) {
    refreshPublishVisibility();
    elements.publish.disabled = !ready || busy;
    if (!ready) showStatus(elements.status, "Loading group memberships…");
    else clearStatus();
  }

  function setSchemaLoadFailed() {
    elements.publish.disabled = true;
    elements.publish.title = publishTitle();
    showStatus(elements.status, "Group memberships could not be verified. Editing and publishing remain disabled.", true);
  }

  return { initialize, publish, share, publicPermalink, currentCanonical, refreshPublicationState, workingCopyChanged, setSchemaReady, setSchemaLoadFailed };
}
