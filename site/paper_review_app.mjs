import { h } from "./dom_builder.mjs";
import { paperStore } from "./paper_store.mjs";
import { validateCapture, confirmedCapture, validateClaims } from "./paper_capture.mjs";
import { checkCappedKey } from "./openrouter_connection.mjs";
import { openRouterJson } from "./definition_jev_core.mjs";
import { PaperModel, validateShape } from "./paper_model.mjs";
import { BrowserEchoSession } from "./paper_browser_session.mjs";
import { extractClaims, qualifyClaim, evaluatePaper, resolveSplit, claimSchema } from "./paper_workflow.mjs";
import { publicSchemaProjection } from "./public_schema_projection.mjs";
import { CONFOUNDER_STATUSES, MANUAL_REVIEW_NOTICE } from "./confounder_status.mjs";

const $ = id => document.getElementById(id);
let run = null, session = null, key = null, busy = false, controller = null, authWindow = null, authNonce = null;
let captureMetadata = { extractionMethod: "paste", capturedAt: new Date().toISOString() };
const fields = ["title", "sourceUrl", "doi", "abstract", "articleText", "coverage"];
const save = async () => { if (run) { run.updatedAt = new Date().toISOString(); run.checkpointRevision = (run.checkpointRevision || 0) + 1; await paperStore.save(run); } };
const text = (id, value) => { $(id).textContent = value; };
function populate(capture) {
  for (const field of fields) $(field).value = capture[field] || "";
  captureMetadata = { extractionMethod: capture.extractionMethod, capturedAt: capture.capturedAt };
  text("capture-note", `Source: ${capture.extractionMethod}. Captured ${capture.capturedAt}. Coverage: ${capture.coverage}. Correct the fields before confirming.`);
}
function render() {
  document.querySelectorAll("button").forEach(button => { button.disabled = busy && !["cancel", "disconnect"].includes(button.id); });
  $("retry").hidden = !run?.pending;
  $("resolve").hidden = !run?.splitRequired;
  text("connection", key ? "Connected · capped key checked · kept in memory" : "Not connected");
  text("qualification", run?.qualification ? JSON.stringify(run.qualification, null, 2) : "");
  const costs = (run?.calls || []).map(call => call.cost);
  const reported = costs.filter(value => typeof value === "number");
  const cost = reported.length ? `reported cost $${reported.reduce((a, b) => a + b, 0).toFixed(4)}${reported.length !== costs.length ? " + unknown charges" : ""}` : "cost unavailable";
  const cached = (run?.calls || []).map(call => call.cachedRead);
  const cache = cached.length && cached.every(value => typeof value === "number") ? `${cached.reduce((a, b) => a + b, 0)} cached input tokens` : "cache usage unavailable or partial";
  text("usage", run?.calls?.length ? `${run.calls.length} model calls · ${cost} · ${cache} · model ${run.model}` : "");
  $("claims").replaceChildren(...(run?.claims || []).map(claim => h("label", { className: "claim" },
    h("input", { type: "radio", name: "claim", value: claim.id, checked: run.selectedClaim?.id === claim.id,
      disabled: busy || Boolean(run.session), onchange: () => action(async () => {
        run.selectedClaim = structuredClone(claim); run.qualification = null; await save(); render();
      }) }), claim.text,
    h("blockquote", { textContent: claim.sourceSentences.join("\n") }))));
  $("result").replaceChildren();
  if (run?.outcome) {
    $("result").append(h("h3", { textContent: "Automated review complete" }),
      h("p", { className: "notice", textContent: MANUAL_REVIEW_NOTICE }),
      h("p", { textContent: run.selectedClaim.text }));
    for (const [id, row] of Object.entries(run.outcome.review.confounders)) {
      const group = (session?.schema || run.session?.schema)?.groups.find(group => group.group_id === id);
      $("result").append(h("div", { className: "status-row" }, h("strong", { textContent: `${group?.label || id} · ${CONFOUNDER_STATUSES[row.status] || row.status}` }), h("p", { textContent: row.reason })));
    }
    $("result").append(h("p", { className: "muted", textContent: run.outcome.limitations.join(" ") }));
  }
  text("outcome", run?.outcome ? JSON.stringify(run.outcome, null, 2) : "");
  if (run?.published?.permalink) $("permalink").replaceChildren(h("a", { href: run.published.permalink, target: "_blank", rel: "noopener noreferrer", textContent: "Open published Echo schema ↗" }));
}
async function listSaved() {
  const runs = (await paperStore.list()).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  $("saved").replaceChildren(...runs.map(record => h("div", { className: "saved-row" },
    h("strong", { textContent: record.capture.title }), h("p", { className: "muted", textContent: `${record.phase} · ${record.updatedAt || record.createdAt}` }),
    h("button", { textContent: "Resume", onclick: () => action(async () => {
      await session?.close(); session = null; run = record;
      populate(run.capture); $("model").value = run.model || "";
      $("claims-json").value = JSON.stringify(run.claims || [], null, 2);
      if (run.pending) { run.phase = "uncertain"; await save(); }
      text("progress", run.pending ? "Interrupted call is uncertain. Explicit retry is required." : `Loaded ${run.phase}. Reconnect to resume model work.`);
      $("publication").hidden = true;
    }) }),
    h("button", { className: "secondary", textContent: "Delete", onclick: () => action(async () => {
      if (run?.id === record.id) { await session?.close(); session = null; run = null; }
      await paperStore.delete(record.id);
    }) }))));
}
async function action(operation) {
  if (busy) return;
  busy = true; controller = new AbortController(); text("error", ""); render();
  // Prevent two windows from editing one run or replaying billable calls concurrently.
  try {
    await navigator.locks.request(`echo-paper:${run?.id || "new"}`, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error("This review is active in another Echo window.");
      if (run) {
        const stored = await paperStore.get(run.id);
        if (stored && stored.checkpointRevision !== run.checkpointRevision) throw new Error("This review changed in another window. Resume its latest saved checkpoint before continuing.");
      }
      await operation();
    });
  } catch (error) {
    text("error", key ? String(error.message).replaceAll(key, "[redacted]") : error.message);
  } finally { busy = false; render(); await listSaved().catch(() => {}); }
}
function model() {
  if (!run) throw new Error("Confirm a paper first.");
  if (!key) throw new Error("Connect your capped OpenRouter key first.");
  const selected = $("model").value.trim();
  if (!selected) throw new Error("Choose an OpenRouter model ID.");
  if (run.model && run.model !== selected && run.calls?.length) throw new Error("A run's model is fixed after its first call. Start a new review to change models.");
  run.model = selected;
  return new PaperModel({ run, getKey: () => key, save, signal: controller.signal,
    onProgress: phase => { text("progress", phase); render(); } });
}
async function connectKey(candidate) {
  await checkCappedKey(candidate, controller?.signal);
  key = candidate;
  text("progress", "OpenRouter connected. Review the paper and model before starting a step.");
}
async function browserSession(client) {
  if (!session) {
    text("progress", "Loading and verifying pinned Echo schema and evidence…");
    session = await BrowserEchoSession.start({ record: run.session || null, getKey: () => key,
      save: async record => { run.session = record; await save(); },
      request: (path, requestKey, options) => client.jevRequest(path, requestKey, options),
      onStatus: phase => text("progress", phase) });
    run.session = session.record;
    await save();
  }
  // Resumed sessions use the current cancellation signal and model journal.
  session.runtime.request = (path, requestKey, options) => client.jevRequest(path, requestKey, options);
  return session;
}

$("confirm").addEventListener("click", () => action(async () => {
  const confirmed = await confirmedCapture({ ...captureMetadata, ...Object.fromEntries(fields.map(field => [field, $(field).value])) });
  await session?.close(); session = null;
  run = { id: crypto.randomUUID(), ...confirmed, phase: "confirmed", claims: [], model: $("model").value.trim(), createdAt: new Date().toISOString() };
  $("publication").hidden = true; $("claims-json").value = "[]";
  await save(); text("progress", "Paper confirmed. New captures and edits cannot change this run's evidence.");
}));
$("connect").addEventListener("click", () => {
  authNonce = crypto.randomUUID();
  authWindow = window.open(`./paper-auth.html#nonce=${authNonce}`, "_blank", "popup,width=680,height=780");
  if (!authWindow) text("error", "Allow the connection popup, or use an existing capped key below.");
});
$("use-key").addEventListener("click", () => action(async () => {
  const candidate = $("key").value.trim(); $("key").value = ""; await connectKey(candidate);
}));
$("disconnect").addEventListener("click", () => { controller?.abort(); key = null; authNonce = null; authWindow?.close(); $("key").value = ""; render(); });
$("extract").addEventListener("click", () => action(async () => {
  const client = model();
  if (run.session) throw new Error("Start a new review to change claims after evaluation has begun.");
  await client.checkModel(); run.claims = await extractClaims(client); run.phase = "claims_extracted";
  run.selectedClaim = null; run.qualification = null;
  $("claims-json").value = JSON.stringify(run.claims, null, 2); await save();
  text("progress", `${run.claims.length} claims extracted. Choose one; extraction may be incomplete.`);
}));
$("save-claims").addEventListener("click", () => action(async () => {
  if (!run || run.session) throw new Error("Confirm a paper, or start a new review to edit evaluated claims.");
  const claims = JSON.parse($("claims-json").value); validateShape({ claims }, claimSchema);
  run.claims = validateClaims(claims, run.capture.abstract); run.selectedClaim = null; run.qualification = null; await save();
}));
$("qualify").addEventListener("click", () => action(async () => {
  const client = model();
  if (run.session) throw new Error("Start a new review to requalify after evaluation has begun.");
  if (!run.selectedClaim) throw new Error("Select a claim first.");
  if (run.capture.coverage !== "full") throw new Error("Supply and confirm full article text before qualification.");
  await client.checkModel(); run.qualification = await qualifyClaim(client); run.phase = "qualified"; await save();
  text("progress", "Claim qualifies for the implemented observational protocol. Inspect the measurements and controls above before running.");
}));
$("evaluate").addEventListener("click", () => action(async () => {
  const client = model();
  if (run.phase === "complete") return;
  if (!run.qualification) throw new Error("Qualify the selected claim first.");
  await client.checkModel(); await evaluatePaper(client, await browserSession(client)); text("progress", `Automated review complete. ${MANUAL_REVIEW_NOTICE}`);
}));
$("resolve").addEventListener("click", () => action(async () => {
  const client = model(); await resolveSplit(client, await browserSession(client));
  text("progress", "Split applied. Resume the review to rebuild evidence and inspect the changed graph.");
}));
$("cancel").addEventListener("click", () => { controller?.abort(); text("progress", "Cancellation requested. Accepted decisions remain saved; in-flight model calls may be billed."); });
$("retry").addEventListener("click", () => action(async () => {
  if (!run?.pending) return;
  run.uncertainCalls ||= []; run.uncertainCalls.push({ ...run.pending, retryAcknowledgedAt: new Date().toISOString() });
  if (run.pending.requestHash) delete run.receipts?.[run.pending.requestHash];
  run.pending = null; run.phase = "retry_acknowledged"; await save(); text("progress", "Retry acknowledged. Choose the interrupted step to continue; earlier accepted decisions remain saved.");
}));
$("export").addEventListener("click", () => action(async () => {
  if (!run) throw new Error("No private review to export.");
  const url = URL.createObjectURL(new Blob([JSON.stringify({ ...run, reviewNotice: MANUAL_REVIEW_NOTICE }, null, 2)], { type: "application/json" }));
  const link = h("a", { href: url, download: `echo-paper-${run.id}.json` }); link.click(); URL.revokeObjectURL(url);
}));
$("preview").addEventListener("click", () => action(async () => {
  if (run?.phase !== "complete") throw new Error("Only a validated complete review can be prepared for publication.");
  if (!session) await browserSession(new PaperModel({ run, getKey: () => key, save, signal: controller.signal }));
  if (session.status === "editing") await session.ready();
  if (session.status !== "ready") throw new Error(`Publication is ${session.status}; uncertain publication cannot be replayed automatically.`);
  text("public-preview", JSON.stringify(publicSchemaProjection(session.schema), null, 2)); $("publication").hidden = false;
}));
$("publish").addEventListener("click", () => action(async () => {
  if (!session || session.status !== "ready" || $("publication").hidden || run.publicationPending || run.published) throw new Error("Preview the completed schema before publishing. An uncertain publication cannot be repeated automatically.");
  run.publicationPending = true; await save();
  run.published = await session.publish(); run.publicationPending = false; await save(); render();
}));

const bridgeNonce = new URLSearchParams(location.hash.slice(1)).get("bridge");
window.addEventListener("message", event => {
  if (event.origin === location.origin && event.source === authWindow && event.data?.type === "echo-paper-connected-v1" && event.data.nonce === authNonce) {
    authNonce = null;
    if (typeof event.data.key === "string") void action(() => connectKey(event.data.key));
    return;
  }
  if (!bridgeNonce || !/^chrome-extension:\/\/[a-p]{32}$/.test(event.origin)
    || ![window.parent, window.opener].includes(event.source) || event.source === window
    || event.data?.type !== "echo-paper-capture-v1" || event.data.nonce !== bridgeNonce) return;
  try {
    const capture = validateCapture(event.data.capture);
    if (busy || run) { text("capture-note", "A new capture arrived. This review remains bound to its confirmed paper. Start a new review in a fresh Echo window to use the new paper."); return; }
    populate(capture);
  } catch { text("error", "The captured paper was invalid. Paste the article text below."); }
});
if (bridgeNonce) {
  // Handshake contains only a nonce, never paper text or credentials. The wrapper checks exact source and Echo origin.
  for (const target of [window.parent !== window ? window.parent : null, window.opener].filter(Boolean)) {
    target.postMessage({ type: "echo-paper-ready-v1", nonce: bridgeNonce }, "*");
  }
}
await listSaved().catch(() => text("error", "Browser storage is unavailable here. Open Echo in a tab to continue."));
render();
