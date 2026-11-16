import { PAPER_PIPELINE } from "./paper_pipeline_contract.mjs";
import { h } from "./dom_builder.mjs";
import { paperStore } from "./paper_store.mjs";
import { validateCapture, confirmedCapture } from "./paper_capture.mjs";
import { checkCappedKey } from "./openrouter_connection.mjs";
import { PaperModel } from "./paper_model.mjs";
import { BrowserEchoSession } from "./paper_browser_session.mjs";
import { extractClaims, qualifyClaim, evaluatePaper, resolveSplit } from "./paper_workflow.mjs";
import { publicSchemaProjection } from "./public_schema_projection.mjs";
import { CONFOUNDER_STATUSES, MANUAL_REVIEW_NOTICE } from "./confounder_status.mjs";
import { unaddressedAssessmentNotice, VALIDATION_NOTICE } from "./paper_review_copy.mjs";

const $ = id => document.getElementById(id);
let run = null, session = null, key = null, busy = false, controller = null, authWindow = null, authNonce = null;
let captureMetadata = { extractionMethod: "paste", capturedAt: new Date().toISOString() };
let bridgeTarget = null, bridgeOrigin = null, connectionPersistent = false;
const bridgeRequests = new Map();
let intake = Promise.resolve(), needsResume = false;
function enqueue(operation) { intake = intake.then(() => action(operation)).catch(() => {}); }
function connectionRequest(type, data = {}) {
  if (!bridgeTarget || !bridgeNonce) return Promise.reject(new Error("Open this page through the extension to remember a connection."));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { bridgeRequests.delete(requestId); reject(new Error("The extension did not confirm saving the connection.")); }, 10000);
    bridgeRequests.set(requestId, { resolve, reject, timer });
    bridgeTarget.postMessage({ type, nonce: bridgeNonce, requestId, ...data }, bridgeOrigin);
  });
}
const fields = ["title", "sourceUrl", "doi", "abstract", "articleText", "coverage"];
const save = async () => { if (run) { run.updatedAt = new Date().toISOString(); run.checkpointRevision = (run.checkpointRevision || 0) + 1; await paperStore.save(run); } };
const displayClaim = claim => claim.replace(/\buoa's /g, "").split(" → ").map(part => part ? part[0].toUpperCase() + part.slice(1) : part).join(" → ");
const text = (id, value) => { $(id).textContent = value; };
function populate(capture) {
  for (const field of fields) $(field).value = capture[field] || "";
  captureMetadata = { extractionMethod: capture.extractionMethod, capturedAt: capture.capturedAt };
  text("paper-title", capture.title); $("paper-title").hidden = !capture.title;
  const meta = [capture.sourceUrl ? new URL(capture.sourceUrl).hostname : "", capture.doi ? `DOI ${capture.doi}` : ""].filter(Boolean).join(" · ");
  text("paper-meta", meta); $("paper-meta").hidden = !meta;
  text("paper-coverage", ({ full: "Full article", partial: "Partial text", abstract_only: "Abstract only", unknown: "Coverage unknown" })[capture.coverage]);
  document.querySelector(".paper-card").dataset.captured = Boolean(capture.title);
  text("capture-note", `Source: ${capture.extractionMethod}. Captured ${capture.capturedAt}. Coverage: ${capture.coverage}. Paper details were filled automatically. Review them before relying on the results.`);
}
function render() {
  document.body.dataset.busy = String(busy);
  document.body.dataset.complete = String(Boolean(run?.outcome));
  $("cancel").hidden = !busy;
  $("export").hidden = !run;
  $("preview").hidden = !run?.outcome;
  const current = run?.outcome || run?.selectedClaim ? "review" : run ? "claim" : "paper";
  for (const [index, name] of ["paper", "claim", "review"].entries()) {
    const step = $(`step-${name}`);
    if (name === current) step.setAttribute("aria-current", "step"); else step.removeAttribute("aria-current");
    step.dataset.complete = String(index < ["paper", "claim", "review"].indexOf(current) || Boolean(run?.outcome));
  }
  text("review-state", run?.outcome ? "Complete" : busy && run?.selectedClaim ? "In progress" : needsResume && run?.selectedClaim ? "Paused" : "Not started");
  text("claim-count", `${run?.claims?.length || 0} extracted`); $("claim-count").hidden = !run?.claims?.length;
  document.querySelectorAll("button").forEach(button => { button.disabled = busy && !["cancel", "disconnect"].includes(button.id); });
  $("retry").hidden = !run?.pending;
  $("resume-review").hidden = !needsResume || !run || Boolean(run.outcome);
  $("connect").hidden = Boolean(key);
  text("connection", key ? `Connected · capped key checked · ${connectionPersistent ? "remembered on this device" : bridgeTarget ? "remembered for this Chrome session" : "this window only"}` : "Connect once to extract claims automatically.");
  text("qualification", run?.qualification ? JSON.stringify(run.qualification, null, 2) : "");
  const costs = (run?.calls || []).map(call => call.cost);
  const reported = costs.filter(value => typeof value === "number");
  const cost = reported.length ? `reported cost $${reported.reduce((a, b) => a + b, 0).toFixed(4)}${reported.length !== costs.length ? " + unknown charges" : ""}` : "cost unavailable";
  const cached = (run?.calls || []).map(call => call.cachedRead);
  const cache = cached.length && cached.every(value => typeof value === "number") ? `${cached.reduce((a, b) => a + b, 0)} cached input tokens` : "cache usage unavailable or partial";
  text("usage", run?.calls?.length ? `${run.calls.length} model calls · ${cost} · ${cache} · model ${run.model}` : "");
  $("claims").replaceChildren(...(run?.claims || []).map(claim => h("label", { className: "claim" },
    h("input", { type: "radio", name: "claim", value: claim.id, checked: run.selectedClaim?.id === claim.id,
      disabled: busy || Boolean(run.session) || claim.eligible === false, onchange: () => action(async () => {
        run.selectedClaim = structuredClone(claim); run.qualification = null; await save(); await reviewSelectedClaim();
      }) }), h("span", { className: "claim-content" }, h("span", { className: "claim-title", textContent: displayClaim(claim.text) }),
    h("p", { className: "muted", textContent: claim.eligibilityNote || "Saved claim from an earlier review." })))));
  if (!run?.claims?.length) $("claims").append(h("div", { className: "empty-state" },
    h("strong", { textContent: run?.pipelineExtraction ? "No causal claims found" : busy && key ? "Finding the paper’s claims…" : "Claims will appear here" }),
    h("p", { textContent: run?.pipelineExtraction ? "The abstract did not provide causal links to review." : "Capture a paper and connect once to get started." })));
  $("result").replaceChildren();
  if (run?.outcome) {
    $("result").append(h("h3", { textContent: "Automated review complete" }),
      h("p", { className: "notice", textContent: VALIDATION_NOTICE }),
      h("p", { className: "notice", textContent: MANUAL_REVIEW_NOTICE }),
      h("p", { textContent: displayClaim(run.selectedClaim.text) }));
    const rows = Object.values(run.outcome.review.confounders);
    $("result").append(h("div", { className: "review-totals" },
      h("div", {}, h("strong", { textContent: rows.length }), h("span", { textContent: "Confounders reviewed" })),
      h("div", {}, h("strong", { textContent: rows.filter(row => row.status === "unaddressed").length }), h("span", { textContent: "May be unaddressed" }))));
    for (const [id, row] of Object.entries(run.outcome.review.confounders)) {
      const group = (session?.schema || run.session?.schema)?.groups.find(group => group.group_id === id);
      $("result").append(h("div", { className: "status-row", dataset: { status: row.status } },
        h("strong", { textContent: `${group?.label || id} · ${CONFOUNDER_STATUSES[row.status] || row.status}` }),
        row.status === "unaddressed" ? h("p", { className: "muted", textContent: row.assessmentNotice || unaddressedAssessmentNotice(group?.label) }) : null,
        h("p", { textContent: row.reason })));
    }
    $("result").append(h("p", { className: "muted", textContent: run.outcome.limitations.join(" ") }));
  }
  text("outcome", run?.outcome ? JSON.stringify(run.outcome, null, 2) : "");
  if (run?.published?.permalink) $("permalink").replaceChildren(h("a", { href: run.published.permalink, target: "_blank", rel: "noopener noreferrer", textContent: "Open published Echo schema ↗" }));
}
async function listSaved() {
  const runs = (await paperStore.list()).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  $("saved").replaceChildren(...runs.map(record => h("div", { className: "saved-row" },
    h("strong", { textContent: record.capture.title }), h("p", { className: "muted", textContent: `${({ complete: "Review complete", claims_extracted: "Choose a claim", confirmed: "Paper captured", qualified: "Claim qualified", uncertain: "Needs attention", split_required: "Review paused" })[record.phase] || "Review in progress"} · ${new Date(record.updatedAt || record.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` }),
    h("button", { textContent: "Resume", onclick: () => action(async () => {
      await session?.close(); session = null; run = record; needsResume = run.phase !== "complete";
      populate(run.capture);
      text("pipeline-extraction", JSON.stringify(run.pipelineExtraction || {}, null, 2));
      if (run.pending) { run.phase = "uncertain"; await save(); }
      text("progress", run.pending ? "Interrupted call is uncertain. Explicit retry is required." : `Loaded ${run.phase}. Accepted work remains saved.`);
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
    needsResume = true;
    text("error", key ? String(error.message).replaceAll(key, "[redacted]") : error.message);
  } finally { busy = false; render(); await listSaved().catch(() => {}); }
}
function model() {
  if (!run) throw new Error("Confirm a paper first.");
  if (!key) throw new Error("Connect your capped OpenRouter key first.");
  if (run.model !== PAPER_PIPELINE.model) throw new Error("This older review uses a different model. Capture the paper again to start a pipeline review.");
  return new PaperModel({ run, getKey: () => key, save, signal: controller.signal,
    onProgress: phase => { text("progress", phase); render(); } });
}
async function connectKey(candidate, { restored = false, persistent = false } = {}) {
  await checkCappedKey(candidate, controller?.signal);
  key = candidate;
  if (!restored && bridgeTarget) {
    const result = await connectionRequest("echo-paper-save-key-v1", { key, persistent: $("remember").checked });
    persistent = result.persistent;
  }
  connectionPersistent = persistent;
  $("remember").checked = persistent;
  text("progress", "Connected. Extracting the paper’s claims with the Echo pipeline…");
  await extractCurrentClaims();
}
async function extractCurrentClaims() {
  if (!run || !key || run.pipelineExtraction || run.pending || run.session) return;
  const client = model();
  await client.checkModel();
  run.claims = await extractClaims(client); run.phase = "claims_extracted";
  run.selectedClaim = null; run.qualification = null;
  await save(); text("pipeline-extraction", JSON.stringify(run.pipelineExtraction, null, 2));
  text("progress", run.claims.length ? "Choose a claim. Its qualification and evidence review will run automatically." : "The Echo pipeline found no causal claims in this abstract.");
}
async function reviewSelectedClaim() {
  const client = model();
  if (run.phase === "complete") return;
  if (!run.selectedClaim) throw new Error("Choose a claim to review.");
  if (run.capture.coverage !== "full") throw new Error("This page did not expose a complete article. Open the full HTML article and capture it again.");
  await client.checkModel();
  if (!run.qualification) {
    run.qualification = await qualifyClaim(client); run.phase = "qualified"; await save();
  }
  const currentSession = await browserSession(client);
  while (run.phase !== "complete") {
    if (run.splitRequired) await resolveSplit(client, currentSession);
    try { await evaluatePaper(client, currentSession); }
    catch (error) { if (!run.splitRequired || run.pending || controller.signal.aborted || (run.splitRounds || 0) >= 3) throw error; }
  }
  text("progress", `Automated review complete. ${MANUAL_REVIEW_NOTICE}`);
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
  session.runtime.classifierModel = run.pipeline ? PAPER_PIPELINE.model : null;
  return session;
}

async function startReview(capture) {
  const confirmed = await confirmedCapture(capture);
  await session?.close(); session = null; needsResume = false;
  run = { id: crypto.randomUUID(), ...confirmed, phase: "confirmed", claims: [], model: PAPER_PIPELINE.model, pipeline: { sourceRevision: PAPER_PIPELINE.sourceRevision, promptVersion: PAPER_PIPELINE.promptVersion }, createdAt: new Date().toISOString() };
  $("publication").hidden = true; text("pipeline-extraction", "");
  await save(); text("progress", key ? "Paper captured. Extracting Echo pipeline claims…" : "Paper captured. Connect once to extract its claims automatically.");
  await extractCurrentClaims();
}
$("confirm").addEventListener("click", () => action(() => startReview({ ...captureMetadata, ...Object.fromEntries(fields.map(field => [field, $(field).value])) })));
$("connect").addEventListener("click", () => {
  authNonce = crypto.randomUUID();
  authWindow = window.open(`./paper-auth.html#nonce=${authNonce}`, "_blank", "popup,width=680,height=780");
  if (!authWindow) text("error", "Allow the connection popup, or use an existing capped key below.");
});
$("use-key").addEventListener("click", () => action(async () => {
  const candidate = $("key").value.trim(); $("key").value = ""; await connectKey(candidate);
}));
$("remember").addEventListener("change", () => {
  if (!key || !bridgeTarget) return;
  void action(async () => {
    const result = await connectionRequest("echo-paper-save-key-v1", { key, persistent: $("remember").checked });
    connectionPersistent = result.persistent;
  });
});
$("disconnect").addEventListener("click", () => {
  controller?.abort(); key = null; authNonce = null; authWindow?.close(); $("key").value = "";
  connectionPersistent = false; render();
  if (bridgeTarget) void connectionRequest("echo-paper-forget-key-v1").catch(error => text("error", error.message));
});
$("resume-review").addEventListener("click", () => action(async () => {
  if (run?.selectedClaim) await reviewSelectedClaim(); else await extractCurrentClaims();
}));
$("cancel").addEventListener("click", () => { controller?.abort(); text("progress", "Cancellation requested. Accepted decisions remain saved; in-flight model calls may be billed."); });
$("retry").addEventListener("click", () => action(async () => {
  if (!run?.pending) return;
  run.uncertainCalls ||= []; run.uncertainCalls.push({ ...run.pending, retryAcknowledgedAt: new Date().toISOString() });
  if (run.pending.requestHash) delete run.receipts?.[run.pending.requestHash];
  run.pending = null; run.phase = "retry_acknowledged"; await save(); text("progress", "Retry acknowledged. Use Resume interrupted review to continue; earlier accepted decisions remain saved.");
}));
$("export").addEventListener("click", () => action(async () => {
  if (!run) throw new Error("No private review to export.");
  const url = URL.createObjectURL(new Blob([JSON.stringify({ ...run, reviewNotice: MANUAL_REVIEW_NOTICE, validationNotice: VALIDATION_NOTICE }, null, 2)], { type: "application/json" }));
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
    if (typeof event.data.key === "string") enqueue(() => connectKey(event.data.key));
    return;
  }
  if (!bridgeNonce || !/^chrome-extension:\/\/[a-p]{32}$/.test(event.origin)
    || ![window.parent, window.opener].includes(event.source) || event.source === window
    || event.data?.nonce !== bridgeNonce) return;
  bridgeTarget = event.source; bridgeOrigin = event.origin;
  if (["echo-paper-key-saved-v1", "echo-paper-storage-error-v1"].includes(event.data.type)) {
    const request = bridgeRequests.get(event.data.requestId);
    if (request) { clearTimeout(request.timer); bridgeRequests.delete(event.data.requestId); event.data.type === "echo-paper-storage-error-v1" ? request.reject(new Error(event.data.message)) : request.resolve(event.data); }
    else if (event.data.type === "echo-paper-storage-error-v1") text("error", event.data.message);
    return;
  }
  if (event.data.type === "echo-paper-forgotten-v1") {
    controller?.abort(); key = null; connectionPersistent = false; render(); return;
  }
  if (event.data.type === "echo-paper-connection-v1") {
    if (typeof event.data.key === "string" && !key) enqueue(() => connectKey(event.data.key, { restored: true, persistent: event.data.persistent }));
    return;
  }
  if (event.data.type !== "echo-paper-capture-v1") return;
  try {
    const capture = validateCapture(event.data.capture);
    if (run?.capture.sourceUrl === capture.sourceUrl && run.capture.articleText === capture.articleText) return;
    if (busy && run) { text("capture-note", "A new capture arrived while a step was running. Finish or cancel that step, then click the Echo toolbar icon again. Your existing review is saved."); return; }
    populate(capture);
    if (capture.title && capture.abstract && capture.articleText) {
      $("paper-details").open = false;
      text("paper-summary", "Paper details / edit capture");
      enqueue(async () => {
        if (run?.capture.sourceUrl === capture.sourceUrl && run.capture.articleText === capture.articleText) return;
        await startReview(capture);
      });
    } else {
      $("paper-details").open = true;
      text("capture-note", "The page did not expose a complete abstract. Open the publisher's HTML article and click the Echo toolbar icon again.");
    }
  } catch { text("error", "The captured page was not a valid article. Open the publisher's HTML article and click the Echo toolbar icon again."); }
});
if (bridgeNonce) {
  // Handshake contains only a nonce, never paper text or credentials. The wrapper checks exact source and Echo origin.
  for (const target of [window.parent !== window ? window.parent : null, window.opener].filter(Boolean)) {
    target.postMessage({ type: "echo-paper-ready-v1", nonce: bridgeNonce }, "*");
  }
}
await listSaved().catch(() => text("error", "Browser storage is unavailable here. Open Echo in a tab to continue."));
render();
