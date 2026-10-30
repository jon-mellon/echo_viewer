import { buildPermalink } from "./dag_permalink.mjs";
import { commitLocalSchema, mirrorSessionUrl, updateLocalPublication, urlSequence } from "./local_schema_store.mjs";
import { validateGroupingSchema } from "./data_validation.mjs";
import { GROUPING_FORMAT_VERSION, GROUPING_MEMBERSHIP_UNIT } from "./app_contracts.mjs";

export function createPersistentViewer({ state, getSchema, getViewport = () => {},
  status = () => {}, onDiscard = () => {} }) {
  let localRecord = null;
  let committedSchema = null;
  let editorBaseline = null;
  let urlTimer = null;
  let ready = false;
  let commitPending = null;
  let unsavedSchema = false;
  let sessionId = null;

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const baseId = () => state.data?.publication_source?.publication_id || "";
  const baseHash = () => state.data?.publication_source?.content_hash || "";
  const sessionTitle = () => {
    const groups = state.project?.groups || [];
    const label = id => groups.find(group => group.group_id === id)?.label || "";
    const iv = label(state.project?.iv_group_id), dv = label(state.project?.dv_group_id);
    return iv && dv ? `${iv} → ${dv}` : iv ? `${iv} → select outcome` : "New view";
  };
  const replaceUrl = url => history.replaceState({ ...(history.state || {}), echoSessionId: sessionId }, "", url);

  function currentUrl(localId = localRecord?.id || "") {
    if (!state.project || !state.data) return null;
    const groups = state.project.groups || [];
    const iv = groups.find(group => group.group_id === state.project.iv_group_id);
    const dv = groups.find(group => group.group_id === state.project.dv_group_id);
    if (!localId && state.workflowMode !== "setup"
      && (!iv?.variable_ids?.length || !dv?.variable_ids?.length)) return null;
    getViewport();
    return buildPermalink({
      location: window.location, schemaUrl: "", dataVersion: state.data.snapshot?.snapshot_id || "",
      state, publishedSchemaId: baseId(), localSchemaId: localId,
    });
  }

  function setLoadedRecord(record) { localRecord = record; }

  function start() {
    committedSchema = structuredClone(getSchema());
    ready = true;
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem("echo-pending-session-restore") || "null"); }
    catch { /* An invalid handoff starts an independent session. */ }
    sessionStorage.removeItem("echo-pending-session-restore");
    sessionId = pending?.url === window.location.href && pending.id
      ? pending.id : history.state?.echoSessionId || crypto.randomUUID();
    replaceUrl(window.location.href);
    void navigator.storage?.persist?.().catch(() => {});
    if (new URL(window.location.href).searchParams.has("p")) {
      void mirrorSessionUrl(sessionId, window.location.href, urlSequence(), sessionTitle()).catch(error =>
        status(`Previous view not saved — ${error.message}`));
    }
    viewerChanged();
  }

  function beginEditor() {
    if (editorBaseline || !ready) return;
    editorBaseline = {
      schema: structuredClone(getSchema()),
      project: structuredClone(state.project),
      compiledDag: state.compiledDag ? structuredClone(state.compiledDag) : null,
      phase: state.phase, workflowMode: state.workflowMode,
    };
    status("Editing — changes are not saved");
  }

  function discardEditor() {
    if (!editorBaseline) return;
    state.project = editorBaseline.project;
    state.compiledDag = editorBaseline.compiledDag;
    state.phase = editorBaseline.phase;
    state.workflowMode = editorBaseline.workflowMode;
    editorBaseline = null;
    unsavedSchema = false;
    onDiscard();
    status("Editor changes discarded");
  }

  async function commitCurrentSchema() {
    if (commitPending) {
      await commitPending;
      return commitCurrentSchema();
    }
    const schema = getSchema();
    if (committedSchema && same(schema, committedSchema)) {
      unsavedSchema = false;
      return false;
    }
    validateGroupingSchema(schema);
    if (schema.schema_version !== GROUPING_FORMAT_VERSION
      || schema.membership_unit !== GROUPING_MEMBERSHIP_UNIT) {
      throw new Error("Unsupported grouping schema format.");
    }
    const id = localRecord?.id || crypto.randomUUID();
    const url = currentUrl(id);
    if (!url) throw new Error("Cannot construct a recovery URL for this draft.");
    if (urlTimer !== null) { clearTimeout(urlTimer); urlTimer = null; }
    status("Saving locally…");
    const pending = commitLocalSchema({
      id, expectedRevision: localRecord?.revision || 0, schema, url,
      sequence: urlSequence(), basePublicationId: baseId(), basePublicationHash: baseHash(),
      sessionId, sessionTitle: sessionTitle(),
    }).then(record => {
      localRecord = record;
      committedSchema = structuredClone(schema);
      unsavedSchema = false;
      replaceUrl(url);
      status("Saved locally · Unpublished changes");
      return true;
    }).catch(error => {
      unsavedSchema = true;
      status(`Not saved — ${error.message}`);
      throw error;
    }).finally(() => { commitPending = null; });
    commitPending = pending;
    return pending;
  }

  async function finishEditor() {
    if (!editorBaseline) return true;
    if (same(getSchema(), editorBaseline.schema)) {
      state.project = editorBaseline.project;
      state.compiledDag = editorBaseline.compiledDag;
      state.phase = editorBaseline.phase;
      state.workflowMode = editorBaseline.workflowMode;
      editorBaseline = null;
      unsavedSchema = false;
      onDiscard();
      status(localRecord ? "Saved locally" : "Published schema");
      return true;
    }
    await commitCurrentSchema();
    editorBaseline = null;
    return true;
  }

  async function commitDecision() {
    if (!ready || editorBaseline) return;
    await commitCurrentSchema();
  }

  async function markPublished(publication) {
    if (!localRecord) return;
    try { localRecord = await updateLocalPublication(localRecord.id, localRecord.revision, publication); }
    catch (error) { status(`Published, but local publication metadata was not saved — ${error.message}`); }
  }

  async function saveIndependentCopy() {
    const schema = getSchema();
    validateGroupingSchema(schema);
    const id = crypto.randomUUID();
    const url = currentUrl(id);
    if (!url) throw new Error("Cannot construct a URL for this draft.");
    status("Saving independent copy…");
    const record = await commitLocalSchema({ id, expectedRevision: 0, schema, url,
      basePublicationId: baseId(), basePublicationHash: baseHash(),
      sessionId, sessionTitle: sessionTitle() });
    localRecord = record;
    committedSchema = structuredClone(schema);
    editorBaseline = null;
    unsavedSchema = false;
    replaceUrl(url);
    status("Saved independent local copy · Unpublished changes");
    return record;
  }

  function viewerChanged(continuous = false) {
    if (!ready || editorBaseline || state.definitionDraft || commitPending || unsavedSchema) return;
    if (urlTimer !== null) clearTimeout(urlTimer);
    urlTimer = setTimeout(() => {
      urlTimer = null;
      if (commitPending || editorBaseline || unsavedSchema) return;
      const url = currentUrl();
      if (!url || url === window.location.href) return;
      const sequence = urlSequence();
      replaceUrl(url);
      void mirrorSessionUrl(sessionId, url, sequence, sessionTitle())
        .catch(error => status(`Previous view not saved — ${error.message}`));
    }, continuous ? 350 : 0);
  }

  function flushUrl() {
    if (!ready || editorBaseline || state.definitionDraft || commitPending || unsavedSchema) return;
    if (urlTimer !== null) clearTimeout(urlTimer);
    urlTimer = null;
    const url = currentUrl();
    if (!url) return;
    const sequence = urlSequence();
    if (url !== window.location.href) replaceUrl(url);
    return mirrorSessionUrl(sessionId, url, sequence, sessionTitle())
      .catch(error => status(`Previous view not saved — ${error.message}`));
  }

  function clearSaveFailure() {
    unsavedSchema = false;
    status("Definition draft remains in memory");
  }

  return { setLoadedRecord, start, beginEditor, discardEditor, finishEditor, markPublished,
    saveIndependentCopy,
    clearSaveFailure,
    commitDecision, viewerChanged, flushUrl, currentUrl,
    get sessionId() { return sessionId; },
    get localRecord() { return localRecord; },
    get editorOpen() { return Boolean(editorBaseline); },
    get editorDirty() { return Boolean(editorBaseline && !same(getSchema(), editorBaseline.schema)); },
    get canPublish() { return ready && !editorBaseline && !commitPending && !unsavedSchema
      && Boolean(committedSchema && same(getSchema(), committedSchema)); },
  };
}
