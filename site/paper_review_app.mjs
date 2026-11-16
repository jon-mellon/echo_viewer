import { requestFailure } from "./paper_request_error.mjs";
import { spendLabel, reviewSpend } from "./paper_spend.mjs";
import { recoveryState, acknowledgeRetry } from "./paper_review_state.mjs?v=request-diagnostics-v2";
import { REVIEW_STAGES, recordProgress, progressSnapshot, elapsedLabel } from "./paper_progress.mjs";
import { PAPER_PIPELINE } from "./paper_pipeline_contract.mjs";
import { h } from "./dom_builder.mjs";
import { paperStore } from "./paper_store.mjs";
import { validateCapture, confirmedCapture, NO_ADJUSTMENT_IDENTIFIED_NOTICE } from "./paper_capture.mjs?v=request-diagnostics-v2";
import { checkCappedKey } from "./openrouter_connection.mjs";
import { PaperModel } from "./paper_model.mjs?v=request-diagnostics-v2";
import { BrowserEchoSession } from "./paper_browser_session.mjs";
import { extractClaims, qualifyClaim, evaluatePaper, resolveSplit } from "./paper_workflow.mjs?v=request-diagnostics-v2";
import { publicSchemaProjection } from "./public_schema_projection.mjs";
import { CONFOUNDER_STATUSES, MANUAL_REVIEW_NOTICE } from "./confounder_status.mjs";
import { unaddressedAssessmentNotice, VALIDATION_NOTICE } from "./paper_review_copy.mjs";

const $ = id => document.getElementById(id);
let run = null, session = null, key = null, busy = false, controller = null, authWindow = null, authNonce = null;
let captureMetadata = { extractionMethod: "paste", capturedAt: new Date().toISOString() };
let bridgeTarget = null, bridgeOrigin = null, connectionPersistent = false;
const bridgeRequests = new Map();
let errorMessage = "", showClaimChoices = false;
let intake = Promise.resolve(), needsResume = false, operationStartedAt = Date.now(), progressTimer = null;
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
function renderActivity() {
  const state = progressSnapshot(run, { busy, startedAt: operationStartedAt, needsResume });
  const recovery = !busy && (needsResume || run?.pending || errorMessage) ? recoveryState(run, { connected: Boolean(key), error: errorMessage }) : null;
  const panel = $("review-activity");
  panel.hidden = !run || !(busy || run.selectedClaim || run.outcome || needsResume) || (showClaimChoices && !busy);
  panel.dataset.state = recovery ? "paused" : state.state;
  const update = (id, value) => { if ($(id).textContent !== value) text(id, value); };
  const cancelling = busy && controller?.signal.aborted;
  update("activity-spend", spendLabel(run));
  $("review-cost").hidden = !run;
  const spend = reviewSpend(run), money = value => `$${value.toFixed(4)} (${(value * 100).toFixed(2)}¢)`;
  update("cost-confirmed", money(spend.reported));
  $("cost-unconfirmed-row").hidden = !spend.estimated && !spend.unknown;
  update("cost-unconfirmed", `${spend.estimated ? `Estimated ${money(spend.estimated)}` : ""}${spend.unknown ? `${spend.estimated ? " + " : ""}cost unavailable for ${spend.unknown} request${spend.unknown === 1 ? "" : "s"}` : ""}`);
  update("cost-explanation", spend.estimated || spend.unknown ? "The total billed is not yet known. The final charge may be higher than the confirmed amount." : "Includes successful and unsuccessful AI requests in this review.");
  update("action-help", busy ? "Stop review prevents new requests. A request already sent may still be charged. Your completed work is saved." : "Viewing this screen sends no AI requests and adds no charges.");
  update("activity-title", cancelling ? "Stopping review" : recovery ? recovery.title : state.title);
  update("activity-elapsed", busy ? `${elapsedLabel(state.elapsedSeconds)} elapsed` : state.state === "complete" ? "Saved" : "");
  $("activity-elapsed").hidden = !busy && state.state !== "complete";
  update("activity-detail", recovery ? "" : cancelling ? "Waiting for the current operation to stop. Your completed work is saved." : state.state === "not_qualified" ? `The AI could not review this claim: ${run.qualification.reason} Choose another claim to continue.` : state.detail);
  $("activity-detail").hidden = Boolean(recovery);
  $("recovery-message").hidden = !recovery;
  update("recovery-step", recovery?.step ? `Stopped during: ${recovery.step}` : "");
  $("review-action").dataset.intent = recovery?.intent || "retry";
  $("request-diagnostic").hidden = !recovery?.diagnostic;
  $("retry-after-fix").hidden = !recovery?.diagnostic || recovery.diagnostic.retryable !== false || recovery.diagnostic.kind === "cancelled";
  update("request-diagnostic-data", recovery?.diagnostic ? JSON.stringify(recovery.diagnostic, null, 2) : "");
  update("recovery-summary", recovery?.message || "");
  update("recovery-reason", recovery?.reason || ""); $("recovery-reason").hidden = !recovery?.reason;
  update("recovery-cost", recovery?.cost || ""); $("recovery-cost").hidden = !recovery?.cost;
  const chooseAgain = !busy && state.state === "not_qualified";
  $("review-action").hidden = !recovery && !chooseAgain;
  update("review-action", chooseAgain ? "Choose another claim" : recovery?.action || "Retry unfinished step");
  update("activity-wait", state.waiting);
  $("activity-wait").hidden = !state.waiting;
  update("activity-confounders", state.total === null ? state.stage === "map" ? "Finding confounders…" : "Confounders: pending" : `${state.assessed} of ${state.total} confounders assessed`);
  update("activity-findings", `${state.decisions} evidence decisions`);
  update("activity-calls", `${state.completedCalls} AI responses received`);
  $("activity-meter").hidden = !busy;
  if (state.determinate) { $("activity-meter").max = state.total; $("activity-meter").value = state.assessed; }
  else $("activity-meter").removeAttribute("value");
  $("activity-stages").hidden = !busy || !run?.selectedClaim;
  $("activity-counts").hidden = !busy && state.state !== "complete";
  const stageSignature = `${state.stage}:${state.state}`;
  if ($("activity-stages").dataset.signature !== stageSignature) {
    $("activity-stages").dataset.signature = stageSignature;
    $("activity-stages").replaceChildren(...REVIEW_STAGES.map(([id, title], index) => h("li", {
      dataset: { state: state.stage === id ? "current" : state.stageIndex > index || state.state === "complete" ? "done" : "next" },
      attrs: state.stage === id ? { "aria-current": "step" } : {}
    }, h("span", { attrs: { "aria-hidden": "true" }, textContent: state.stageIndex > index ? "✓" : String(index + 1) }), title)));
  }
  const logSignature = JSON.stringify(state.history);
  if ($("activity-log").dataset.signature !== logSignature) {
    $("activity-log").dataset.signature = logSignature;
    $("activity-log").replaceChildren(...state.history.slice(-6).reverse().map(event => h("li", {},
      h("time", { dateTime: event.at, textContent: new Date(event.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }) }),
      h("span", { textContent: event.detail || event.title }))));
  }
}
function activity(stage, title, detail = "") {
  if (run) recordProgress(run, stage, title, detail);
  text("progress", title); renderActivity();
}
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
  renderActivity();
  document.body.dataset.busy = String(busy);
  if (bridgeTarget && bridgeNonce) bridgeTarget.postMessage({ type: "echo-paper-status-v1", nonce: bridgeNonce, busy, reviewId: run?.id || null,
    message: busy ? "Review running automatically. Progress and charges are shown below." : run?.outcome ? "Review complete. Results and charges are shown below." : run?.selectedClaim ? "Review paused. No AI requests are running. See the next action and charges below." : run?.claims?.length ? "Choose one claim below to start its review." : "Connect once below; ECHO will read the paper automatically." }, bridgeOrigin);
  document.body.dataset.complete = String(Boolean(run?.outcome));
  $("cancel").hidden = !busy;
  $("export").hidden = !run;
  const selected = Boolean(run?.selectedClaim);
  document.querySelector(".claims-card").hidden = (selected || (!busy && needsResume && Boolean(run?.pending || errorMessage || !run?.pipelineExtraction))) && !showClaimChoices;
  document.querySelector(".evidence-card").hidden = !run?.outcome;
  document.querySelector(".review-intro").hidden = selected;
  document.querySelector(".review-steps").hidden = selected;
  $("selected-claim").hidden = !selected || showClaimChoices;
  text("selected-claim-text", selected ? displayClaim(run.selectedClaim.text) : "");
  $("change-claim").hidden = busy || Boolean(run?.session) || run?.qualification?.eligible === false;
  $("change-claim").textContent = showClaimChoices ? "Keep this claim" : "Change claim";
  $("preview").hidden = !run?.outcome;
  const notQualified = run?.qualification?.eligible === false;
  const current = notQualified ? "claim" : run?.outcome || run?.selectedClaim ? "review" : run ? "claim" : "paper";
  for (const [index, name] of ["paper", "claim", "review"].entries()) {
    const step = $(`step-${name}`);
    if (name === current) step.setAttribute("aria-current", "step"); else step.removeAttribute("aria-current");
    step.dataset.complete = String(index < ["paper", "claim", "review"].indexOf(current) || Boolean(run?.outcome));
  }
  text("review-state", notQualified ? "Not qualified" : run?.outcome ? "Complete" : busy && run?.selectedClaim ? "In progress" : needsResume && run?.selectedClaim ? "Paused" : "Not started");
  text("claim-count", `${run?.claims?.length || 0} extracted`); $("claim-count").hidden = !run?.claims?.length;
  document.querySelectorAll("button").forEach(button => { button.disabled = busy && !["cancel", "disconnect"].includes(button.id); });
  $("connect").hidden = Boolean(key);
  text("connection", key ? `Connected · capped key checked · ${connectionPersistent ? "remembered on this device" : bridgeTarget ? "remembered for this Chrome session" : "this window only"}` : "Connect once to extract claims automatically.");
  text("settings-connection", $("connection").textContent);
  text("qualification", run?.qualification ? JSON.stringify(run.qualification, null, 2) : "");
  const cost = spendLabel(run);
  const cached = (run?.calls || []).map(call => call.cachedRead);
  const cache = cached.length && cached.every(value => typeof value === "number") ? `${cached.reduce((a, b) => a + b, 0)} cached input tokens` : "cache usage unavailable or partial";
  text("usage", run?.calls?.length ? `${run.calls.length} model calls · ${cost} · ${cache} · model ${run.model}` : "");
  $("claims").replaceChildren(...(run?.claims || []).map(claim => {
    const assessment = run?.claimQualifications?.[claim.id] || (run?.selectedClaim?.id === claim.id ? run.qualification : null);
    const rejected = assessment?.eligible === false;
    return h("div", { className: "claim-option" },
      h("label", { className: "claim" },
        h("input", { type: "radio", name: "claim", value: claim.id, checked: run.selectedClaim?.id === claim.id,
          disabled: busy || Boolean(run.session) || claim.eligible === false, onclick: () => { if (showClaimChoices && run.selectedClaim?.id === claim.id) { showClaimChoices = false; render(); } }, onchange: () => action(async () => {
            needsResume = false; showClaimChoices = false;
            run.selectedClaim = structuredClone(claim); run.qualification = run.claimQualifications?.[claim.id] || null;
            await save(); await reviewSelectedClaim();
          }) }),
        h("span", { className: "claim-content" }, h("span", { className: "claim-title", textContent: displayClaim(claim.text) }),
          h("p", { className: "muted", textContent: rejected ? "Full-text check: not qualified for this preview’s review protocol." : claim.eligibilityNote || "Saved claim from an earlier review." }))),
      rejected ? h("aside", { className: "qualification-note", attrs: { "aria-label": "Full-text qualification assessment" } },
        h("strong", { textContent: "The AI could not qualify this claim" }),
        h("p", { textContent: "This preview supports person-level observational claims with an explicit or implied causal interpretation, including unadjusted estimates. The AI did not verify that this claim fits that scope in the captured text. This assessment may be incorrect or incomplete; manually check the methods, tables and supplementary material." }),
        h("details", {}, h("summary", { textContent: "Why the AI stopped" }), h("p", { className: "qualification-reason", textContent: assessment.reason }), assessment.designEvidenceQuote ? h("blockquote", { textContent: assessment.designEvidenceQuote }) : null),
        h("p", { className: "muted", textContent: "No confounder review was completed for this claim. You can choose a different extracted claim." })) : null);
  }));
  if (!run?.claims?.length) $("claims").append(h("div", { className: "empty-state" },
    h("strong", { textContent: run?.pipelineExtraction ? "No causal claims found" : busy && key ? "Finding the paper’s claims…" : "Claims will appear here" }),
    h("p", { textContent: run?.pipelineExtraction ? "The abstract did not provide causal links to review." : "Capture a paper and connect once to get started." })));
  $("result").replaceChildren();
  if (run?.outcome) {
    $("result").append(
      h("p", { className: "notice", textContent: VALIDATION_NOTICE }),
      h("p", { className: "notice", textContent: MANUAL_REVIEW_NOTICE }),
      h("p", { textContent: displayClaim(run.selectedClaim.text) }));
    if (!run.qualification.controls.length) $("result").append(h("aside", { className: "adjustment-note" }, h("strong", { textContent: "No adjustment identified in the captured text" }), h("p", { textContent: NO_ADJUSTMENT_IDENTIFIED_NOTICE })));
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
async function loadSaved(record) {
  await session?.close(); session = null; run = record;
  errorMessage = run.failure?.message || run.pending?.error || ""; text("error", errorMessage);
  showClaimChoices = false; needsResume = !["complete", "not_qualified", "claims_extracted"].includes(run.phase);
  populate(run.capture); $("paper-details").open = false;
  text("pipeline-extraction", JSON.stringify(run.pipelineExtraction || {}, null, 2));
  $("publication").hidden = true;
}
async function listSaved() {
  const runs = (await paperStore.list()).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  const totals = runs.map(reviewSpend).reduce((a, b) => ({ reported: a.reported + b.reported, estimated: a.estimated + b.estimated, unknown: a.unknown + b.unknown }), { reported: 0, estimated: 0, unknown: 0 });
  text("saved-cost-total", `Across these saved reviews: $${totals.reported.toFixed(4)} confirmed${totals.estimated ? ` + $${totals.estimated.toFixed(4)} estimated` : ""}${totals.unknown ? " + charges not yet confirmed" : ""}.`);
  $("saved").replaceChildren(...runs.map(record => h("div", { className: "saved-row" },
    h("strong", { textContent: record.capture.title }),
    record.selectedClaim ? h("p", { textContent: displayClaim(record.selectedClaim.text) }) : null,
    h("p", { className: "muted", textContent: `${record.outcome ? "Complete" : record.selectedClaim ? "Paused" : "Waiting for a claim"} · ${new Date(record.updatedAt || record.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` }),
    h("p", { className: "muted", textContent: `This review: ${spendLabel(record)}` }),
    h("div", { className: "saved-actions" },
      record.id === run?.id ? h("span", { className: "current-review", textContent: "Currently open" }) : h("button", { textContent: "View saved review", onclick: () => action(async () => {
        const latest = await paperStore.get(record.id);
        if (!latest) throw new Error("This saved review was removed.");
        await loadSaved(latest);
        $("review-history").open = false;
        $("review-cost").scrollIntoView({ block: "start" });
      }, { readOnly: true }) }),
      h("button", { className: "secondary", textContent: "Delete saved review", onclick: () => action(async () => {
        if (run?.id === record.id) { await session?.close(); session = null; run = null; }
        await paperStore.delete(record.id);
      }) })))));
}

async function action(operation, { readOnly = false } = {}) {
  if (busy) return;
  busy = true; operationStartedAt = Date.now(); controller = new AbortController(); errorMessage = ""; text("error", ""); render();
  let canSaveFailure = false;
  progressTimer = setInterval(renderActivity, 1000);
  // Prevent two windows from editing one run or replaying billable calls concurrently.
  try {
    await navigator.locks.request(`echo-paper:${run?.id || "new"}`, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error("This review is active in another Echo window.");
      if (run && !readOnly) {
        const stored = await paperStore.get(run.id);
        if (stored && stored.checkpointRevision !== run.checkpointRevision) throw new Error("This review changed in another window. Resume its latest saved checkpoint before continuing.");
      }
      canSaveFailure = !readOnly;
      if (run && !readOnly) run.failure = null;
      await operation();
    });
  } catch (error) {
    needsResume = true;
    errorMessage = key ? String(error.message).replaceAll(key, "[redacted]") : String(error.message);
    text("error", errorMessage);
    if (run && canSaveFailure) {
      run.failure = { message: errorMessage, ...(error.kind || error.status ? { requestError: requestFailure(error, { key, step: run.progress?.title, model: run.model, cancelled: controller.signal.aborted }) } : {}), at: new Date().toISOString() };
      await save().catch(() => {});
    }
  } finally { clearInterval(progressTimer); progressTimer = null; busy = false; render(); await listSaved().catch(() => {}); if (errorMessage && run) $("review-cost").scrollIntoView({ block: "start" }); }
}
function model() {
  if (!run) throw new Error("Confirm a paper first.");
  if (!key) throw new Error("Connect your capped OpenRouter key first.");
  if (run.model !== PAPER_PIPELINE.model) throw new Error("This older review uses a different model. Capture the paper again to start a pipeline review.");
  return new PaperModel({ run, getKey: () => key, save, signal: controller.signal,
    onProgress: event => { if (typeof event !== "string") activity(run.progress?.stage || "qualify", event.title, event.detail || ""); else text("progress", event); render(); } });
}
async function connectKey(candidate, { restored = false, persistent = false } = {}) {
  await checkCappedKey(candidate, controller?.signal);
  key = candidate;
  if (!restored && bridgeTarget) {
    const result = await connectionRequest("echo-paper-save-key-v1", { key, persistent: $("remember").checked });
    persistent = result.persistent;
  }
  connectionPersistent = persistent;
  if (Number(run?.pending?.requestError?.providerCode || run?.pending?.requestError?.status) === 401) { acknowledgeRetry(run); await save(); }
  $("remember").checked = persistent;
  text("progress", "Connected. Extracting the paper’s claims with the Echo pipeline…");
  await extractCurrentClaims();
}
async function extractCurrentClaims() {
  if (!run || !key || run.pipelineExtraction || run.pending || run.session) return;
  const client = model();
  await client.checkModel();
  run.claims = await extractClaims(client); run.phase = "claims_extracted"; needsResume = false;
  run.selectedClaim = null; run.qualification = null;
  await save(); text("pipeline-extraction", JSON.stringify(run.pipelineExtraction, null, 2));
  text("progress", run.claims.length ? "Choose a claim. Its qualification and evidence review will run automatically." : "The Echo pipeline found no causal claims in this abstract.");
}
async function reviewSelectedClaim() {
  const client = model();
  if (run.phase === "complete") return;
  if (!run.selectedClaim) throw new Error("Choose a claim to review.");
  if (run.capture.coverage !== "full") throw new Error("This page did not expose a complete article. Open the full HTML article and capture it again.");
  activity("qualify", "Checking the selected claim", "Reading the full text and identifying the focal estimate and its controls.");
  await client.checkModel();
  if (!run.qualification) {
    run.qualification = await qualifyClaim(client);
    run.claimQualifications ||= {};
    run.claimQualifications[run.selectedClaim.id] = structuredClone(run.qualification);
    run.phase = run.qualification.eligible ? "qualified" : "not_qualified";
    run.qualificationPolicy = "observational-causal-including-unadjusted-v1";
    await save();
  }
  if (!run.qualification.eligible) {
    needsResume = false;
    text("progress", "The AI could not qualify this claim for the current review protocol. See its full-text assessment beside the claim, or choose another claim.");
    return;
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
    activity("load", "Loading ECHO evidence", "Downloading and verifying the reference dataset. First-time loading can take a little while.");
    await save();
    session = await BrowserEchoSession.start({ record: run.session || null, getKey: () => key,
      save: async record => { run.session = record; await save(); },
      request: (path, requestKey, options) => client.jevRequest(path, requestKey, options),
      onStatus: phase => {
        const message = String(phase);
        const detail = message.includes("published schema") ? "Loading concept definitions and the reference graph…"
          : message.includes("unavailable") ? "Loading additional reference evidence. This can take longer on the first review."
          : message.includes("manifest") ? "Checking which evidence files are needed…"
          : message.includes("variable schema") ? "Loading reference variable definitions…"
          : message.includes("query engine") ? "Preparing the evidence search…" : "Receiving and verifying reference data…";
        activity(run.progress?.stage || "load", run.progress?.title || "Loading ECHO evidence", detail);
      } });
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
  await session?.close(); session = null; needsResume = false; showClaimChoices = false;
  run = { id: crypto.randomUUID(), ...confirmed, phase: "confirmed", claims: [], model: PAPER_PIPELINE.model, pipeline: { sourceRevision: PAPER_PIPELINE.sourceRevision, promptVersion: PAPER_PIPELINE.promptVersion }, createdAt: new Date().toISOString() };
  $("publication").hidden = true; text("pipeline-extraction", "");
  await save(); text("progress", key ? "Paper captured. Extracting Echo pipeline claims…" : "Paper captured. Connect once to extract its claims automatically.");
  await extractCurrentClaims();
}
$("confirm").addEventListener("click", () => action(() => startReview({ ...captureMetadata, ...Object.fromEntries(fields.map(field => [field, $(field).value])) })));
function connectWindow() {
  authNonce = crypto.randomUUID();
  authWindow = window.open(`./paper-auth.html#nonce=${authNonce}`, "_blank", "popup,width=680,height=780");
  if (!authWindow) text("error", "Allow the connection popup, or use an existing capped key in Connection settings.");
}
$("connect").addEventListener("click", connectWindow);
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
$("change-claim").addEventListener("click", () => { showClaimChoices = !showClaimChoices; render(); if (showClaimChoices) $("claims-heading").scrollIntoView({ block: "nearest" }); });
$("review-action").addEventListener("click", () => {
  if ($("review-action").dataset.intent === "reconnect") { key = null; connectWindow(); return; }
  if ($("review-action").dataset.intent === "account") { window.open("https://openrouter.ai/settings/credits", "_blank", "noopener"); return; }
  if ($("review-action").dataset.intent === "diagnostic") {
    const diagnostic = { step: run?.pending?.phase, failure: run?.pending?.requestError, reviewId: run?.id, spend: reviewSpend(run) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(diagnostic, null, 2)], { type: "application/json" }));
    h("a", { href: url, download: "echo-request-error.json" }).click(); URL.revokeObjectURL(url); return;
  }
  if (run?.qualification?.eligible === false) {
    showClaimChoices = true; render(); $("claims-heading").scrollIntoView({ block: "nearest" }); return;
  }
  if (!key) { connectWindow(); return; }
  void action(async () => {
    needsResume = false; acknowledgeRetry(run); await save();
    if (run.selectedClaim) await reviewSelectedClaim(); else await extractCurrentClaims();
  });
});
$("retry-after-fix").addEventListener("click", () => {
  if (!key) { connectWindow(); return; }
  void action(async () => {
    needsResume = false; acknowledgeRetry(run); await save();
    if (run.selectedClaim) await reviewSelectedClaim(); else await extractCurrentClaims();
  });
});
$("cancel").addEventListener("click", () => { controller?.abort(); renderActivity(); text("progress", "Stopping review. Your completed work is saved."); });
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
    if (run?.capture.sourceUrl === capture.sourceUrl && run.capture.articleText === capture.articleText) { render(); return; }
    if (busy && run) { text("capture-note", "A new capture arrived while a step was running. Finish or cancel that step, then click the Echo toolbar icon again. Your existing review is saved."); return; }
    populate(capture);
    if (capture.title && capture.abstract && capture.articleText) {
      $("paper-details").open = false;
      text("paper-summary", "Paper details / edit capture");
      enqueue(async () => {
        if (run?.capture.sourceUrl === capture.sourceUrl && run.capture.articleText === capture.articleText) { render(); return; }
        const existing = (await paperStore.list()).filter(record => record.capture.sourceUrl === capture.sourceUrl && record.capture.articleText === capture.articleText)
          .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
        if (existing) await loadSaved(existing); else await startReview(capture);
      });
    } else {
      $("paper-details").open = true;
      text("capture-note", "The page did not expose a complete abstract. Open the publisher's HTML article and click the Echo toolbar icon again.");
    }
  } catch { text("error", "The captured page was not a valid article. Open the publisher's HTML article and click the Echo toolbar icon again."); }
});
const requestedReview = new URL(location.href).searchParams.get("review");
if (requestedReview) {
  const saved = await paperStore.get(requestedReview).catch(() => null);
  if (saved) await loadSaved(saved);
}
if (bridgeNonce) {
  // Handshake contains only a nonce, never paper text or credentials. The wrapper checks exact source and Echo origin.
  for (const target of [window.parent !== window ? window.parent : null, window.opener].filter(Boolean)) {
    target.postMessage({ type: "echo-paper-ready-v1", nonce: bridgeNonce }, "*");
  }
}
await listSaved().catch(() => text("error", "Browser storage is unavailable here. Open Echo in a tab to continue."));
render();
