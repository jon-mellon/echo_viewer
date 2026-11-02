import { h, replaceChildren } from "./dom_builder.mjs";
import { jevRunId, loadJevRun, listJevRuns, saveJevRun, saveJevBatch, deleteJevRun } from "./definition_jev_checkpoint.mjs";
import { JEV_MODEL as MODEL, JEV_BATCH_SIZE as BATCH_SIZE, JEV_TEST_SIZE as TEST_SIZE, cappedKeyStatus, randomSampleIds, jevRecords, jevRequest, jevResults, openRouterJson, parseJevPricing, jevRequestSizes, estimatedJevCharge } from "./definition_jev_core.mjs";
export { cappedKeyStatus, randomSampleIds } from "./definition_jev_core.mjs";

const OAUTH_PENDING_KEY = "echo-openrouter-pkce-v1";
const OAUTH_DRAFT_KEY = "echo-openrouter-definition-draft-v1";
const OAUTH_RETURN_URL_KEY = "echo-openrouter-return-url-v1";
const REVIEW_PAGE_SIZE = 50;
const SPOT_CHECK_PER_GROUP = 12;

function reviewRank(id) {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

export function spotCheckResults(results) {
  const lowest = [...results].sort((a, b) => a.confidence - b.confidence).slice(0, SPOT_CHECK_PER_GROUP);
  const ranked = [...results].sort((a, b) => reviewRank(a.id) - reviewRank(b.id));
  const newRows = ranked.filter(item => item.side === "new").slice(0, SPOT_CHECK_PER_GROUP);
  const leftoverRows = ranked.filter(item => item.side === "leftover").slice(0, SPOT_CHECK_PER_GROUP);
  return [...new Map([...lowest, ...newRows, ...leftoverRows].map(item => [item.id, item])).values()]
    .sort((a, b) => a.confidence - b.confidence);
}

function formatUsd(amount) {
  return amount > 0 && amount < 0.000001 ? "<$0.000001" : `$${amount.toFixed(6)}`;
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(value) {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

async function keySettingsUrl(key) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return `https://openrouter.ai/keys/${[...hash].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function createDefinitionJevAssist({ elements: els, getDraft, getVariable, onApply,
  onPreviewChange = () => {}, onConnectionChange = () => {}, getReturnUrl = () => location.href, persistDraft }) {
  let key = null;
  let keyInfo = null;
  let pricing = null;
  let settingsUrl = null;
  let preview = null;
  let previewDraft = null;
  let previewMode = null;
  let sampleDraft = null;
  let sampleSignature = null;
  let sampleIds = null;
  let testResults = null;
  let testDescription = null;
  let testInputTokens = null;
  let fullInputTokens = null;
  let costCache = null;
  let spotRows = [];
  let reviewFilter = "spot";
  let reviewPage = 0;
  let busy = false;
  let activePhase = null;
  let activeRequest = null;
  let message = "";
  // "idle" before a key exists, then "checking", "ok", "invalid" (the key breaks a rule) or "error" (the check itself failed).
  let keyCheck = "idle";
  const LOW_SCORE = 0.65;
  let runRevision = 0;
  let checkpoint = null;
  let checkpointDraft = null;
  let checkpointDescription = null;
  let checkpointSignature = null;
  let restorePromise = null;

  function eligibleSignature(draft) {
    return (draft?.eligible_variable_ids || []).join("\u0000");
  }

  function clearPreview({ keepSample = false, keepCheckpoint = false } = {}) {
    activeRequest?.abort("stopped");
    const oldId = checkpoint?.run.id;
    checkpoint = null;
    checkpointDraft = null;
    checkpointDescription = null;
    checkpointSignature = null;
    restorePromise = null;
    if (oldId && !keepCheckpoint) void deleteJevRun(oldId).catch(error =>
      console.warn("Could not remove Jev checkpoint.", error));
    preview = null;
    previewDraft = null;
    previewMode = null;
    testResults = null;
    testDescription = null;
    testInputTokens = null;
    fullInputTokens = null;
    costCache = null;
    spotRows = [];
    reviewFilter = "all";
    reviewPage = 0;
    if (!keepSample) {
      sampleDraft = null;
      sampleSignature = null;
      sampleIds = null;
    }
    onPreviewChange(null);
    runRevision += 1;
    render();
  }

  function ensureSample(draft) {
    const signature = eligibleSignature(draft);
    if (sampleDraft === draft && sampleSignature === signature && sampleIds) return sampleIds;
    sampleDraft = draft;
    sampleSignature = signature;
    sampleIds = randomSampleIds(draft.eligible_variable_ids);
    return sampleIds;
  }

  function checkpointSource(draft, description) {
    return { version: 1, model: MODEL, description,
      split_id: draft.split_id || null,
      source_snapshot: draft.source_snapshot,
      eligible_variable_ids: draft.eligible_variable_ids,
      records: recordsFor(draft.eligible_variable_ids) };
  }

  function phaseBatches(phase) {
    return checkpoint?.batches.filter(batch => batch.phase === phase) || [];
  }

  function completedCount(phase) {
    return phaseBatches(phase).reduce((count, batch) => count + batch.results.length, 0);
  }

  // `base` is where these ids start within the phase's full list, so a second
  // labeling round keeps distinct, stable batch keys.
  function savedPhase(ids, phase, base = 0) {
    const batches = new Map(phaseBatches(phase).map(batch => [batch.offset, batch]));
    const results = [];
    let inputTokens = 0;
    let usageComplete = true;
    for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
      const batch = batches.get(base + offset);
      const expected = ids.slice(offset, offset + BATCH_SIZE);
      if (!batch || batch.results.length !== expected.length
        || batch.results.some((item, index) => item.id !== expected[index])) return null;
      results.push(...batch.results);
      if (batch.inputTokens === null) usageComplete = false;
      else inputTokens += batch.inputTokens;
    }
    return { results, inputTokens: usageComplete ? inputTokens : null };
  }

  // The labeled sample grows in rounds of TEST_SIZE; only complete rounds count.
  function savedRounds(ids) {
    const results = [];
    let inputTokens = 0;
    let usageComplete = true;
    for (let start = 0; start < ids.length; start += TEST_SIZE) {
      const round = savedPhase(ids.slice(start, start + TEST_SIZE), "test", start);
      if (!round) break;
      results.push(...round.results);
      if (round.inputTokens === null) usageComplete = false;
      else inputTokens += round.inputTokens;
    }
    return results.length ? { results, inputTokens: usageComplete ? inputTokens : null } : null;
  }

  function restorePreview(draft, description) {
    const sample = checkpoint?.run.sampleIds;
    if (!Array.isArray(sample) || sample.length < Math.min(TEST_SIZE, draft.eligible_variable_ids.length)
      || sample.length > draft.eligible_variable_ids.length
      || new Set(sample).size !== sample.length
      || sample.some(id => !draft.eligible_variable_ids.includes(id))) {
      throw new Error("Saved AI sample does not match these source variables.");
    }
    costCache = null;
    sampleDraft = draft;
    sampleSignature = eligibleSignature(draft);
    sampleIds = sample;
    const test = savedRounds(sample);
    if (!test) return;
    testResults = test.results;
    testInputTokens = test.inputTokens;
    testDescription = description;
    const sampled = new Set(sample);
    const remaining = draft.eligible_variable_ids.filter(id => !sampled.has(id));
    const full = savedPhase(remaining, "full");
    preview = full ? [...test.results, ...full.results] : test.results;
    fullInputTokens = full?.inputTokens ?? null;
    previewDraft = draft;
    previewMode = full ? "full" : "test";
    spotRows = spotCheckResults(preview);
    reviewFilter = full ? "spot" : "all";
    onPreviewChange(preview.filter(item => item.side === "new").map(item => item.id), previewMode);
  }

  async function restoreForDraft({ force = false } = {}) {
    const draft = getDraft();
    const description = String(draft?.ai_description || "").trim();
    if (draft?.step !== "partition" || !description || !draft.eligible_variable_ids?.length) return;
    const signature = eligibleSignature(draft);
    if (!force && checkpointDraft === draft && checkpointDescription === description
      && checkpointSignature === signature) return restorePromise;
    checkpointDraft = draft;
    checkpointDescription = description;
    checkpointSignature = signature;
    const revision = runRevision;
    restorePromise = (async () => {
      const id = await jevRunId(checkpointSource(draft, description));
      const saved = await loadJevRun(id);
      if (revision !== runRevision || draft !== getDraft()
        || description !== String(draft.ai_description || "").trim()
        || signature !== eligibleSignature(draft)) return;
      checkpoint = saved;
      if (saved) {
        restorePreview(draft, description);
        const testDone = completedCount("test");
        const fullDone = completedCount("full");
        message = previewMode === "full" ? "Full suggestions restored from this browser. Review them before applying."
          : fullDone ? `${fullDone} full-run variables saved in this browser. Connect a capped key and resume the split.`
            : testDone && !testResults ? `${testDone} test variables saved in this browser. Connect a capped key and resume the test.`
              : testResults ? "Test restored from this browser. Run or resume the full split."
                : message;
        render();
      }
    })().catch(error => {
      message = `Could not load saved classification progress: ${error.message}`;
      render();
      restorePromise = null;
      checkpointDraft = null;
      throw error;
    });
    return restorePromise;
  }

  async function ensureCheckpoint(draft, description) {
    const revision = runRevision;
    showProgress("Reading saved progress from this browser…");
    await restoreForDraft();
    if (revision !== runRevision || draft !== getDraft()
      || description !== String(draft.ai_description || "").trim()) return null;
    if (checkpoint) return checkpoint;
    showProgress("Preparing the split checkpoint…");
    const id = await jevRunId(checkpointSource(draft, description));
    if (revision !== runRevision || draft !== getDraft()
      || description !== String(draft.ai_description || "").trim()) return null;
    const sample = ensureSample(draft);
    const run = { id, sampleIds: sample, draft: structuredClone(draft), createdAt: Date.now() };
    showProgress("Saving the split checkpoint in this browser…");
    await saveJevRun(run);
    if (revision !== runRevision || draft !== getDraft()
      || description !== String(draft.ai_description || "").trim()) {
      await deleteJevRun(id);
      return null;
    }
    checkpoint = { run, batches: [] };
    return checkpoint;
  }

  function renderSummary(draft) {
    const newCount = preview.filter(item => item.side === "new").length;
    const low = preview.filter(item => item.confidence < LOW_SCORE).length;
    const total = draft.eligible_variable_ids.length;
    replaceChildren(els.definitionAiSummary,
      h("div", { className: "definition-ai-counts" },
        h("span", {}, h("strong", { textContent: newCount.toLocaleString() }), " suggested In"),
        h("span", {}, h("strong", { textContent: (preview.length - newCount).toLocaleString() }), " suggested Out"),
        h("span", {}, h("strong", { textContent: low.toLocaleString() }), ` low score (under ${Math.round(LOW_SCORE * 100)}%)`)),
      h("p", { className: "small-note", textContent: previewMode === "test"
        ? `${preview.length.toLocaleString()} of ${total.toLocaleString()} concepts classified. Change any suggestion you disagree with; the AI's instructions stay the same.`
        : `All ${total.toLocaleString()} concepts classified. Low-score suggestions are listed first. Every suggestion is used, including those not shown.` }));
  }

  function recordsFor(ids) { return jevRecords(ids, getVariable); }
  function requestFor(batch, description) { return jevRequest(batch, description); }

  function requestSizes(ids, description) { return jevRequestSizes(recordsFor(ids), description); }
  function estimatedCharge(size, calibration = 1) { return estimatedJevCharge(size, pricing, calibration); }

  function renderCost(draft, description) {
    if (!draft || draft.step !== "partition" || !draft.eligible_variable_ids?.length || !description || !key) {
      els.definitionAiCost.textContent = "Connect and describe the new variable to see an estimated cost.";
      return;
    }
    if (!pricing) {
      els.definitionAiCost.textContent = "Cost estimate unavailable. Check model pricing on OpenRouter before running.";
      return;
    }
    const sample = ensureSample(draft);
    const signature = eligibleSignature(draft);
    if (!costCache || costCache.draft !== draft || costCache.signature !== signature
      || costCache.description !== description) {
      const sampled = new Set(sample);
      const rest = draft.eligible_variable_ids.filter(id => !sampled.has(id));
      const restBatchSizes = [];
      for (let offset = 0; offset < rest.length; offset += BATCH_SIZE) {
        restBatchSizes.push({ offset, size: requestSizes(rest.slice(offset, offset + BATCH_SIZE), description) });
      }
      costCache = { draft, signature, description, testSize: requestSizes(sample, description),
        restSize: requestSizes(rest, description), restBatchSizes };
    }
    const { testSize, restSize } = costCache;
    const calibrated = testInputTokens !== null && testDescription === description
      && testSize.inputTokens > 0 ? testInputTokens / testSize.inputTokens : 1;
    const testCost = testInputTokens !== null && testDescription === description
      ? estimatedCharge({ ...testSize, inputTokens: testInputTokens }, 1)
      : estimatedCharge(testSize);
    const completed = new Set(phaseBatches("full").map(batch => batch.offset));
    const remainingSize = { inputTokens: 0, requests: 0, records: 0 };
    for (const { offset, size } of costCache.restBatchSizes) {
      if (completed.has(offset)) continue;
      remainingSize.inputTokens += size.inputTokens;
      remainingSize.requests += size.requests;
      remainingSize.records += size.records;
    }
    const fullCost = fullInputTokens !== null && previewMode === "full"
      ? estimatedCharge({ ...restSize, inputTokens: fullInputTokens })
      : estimatedCharge(remainingSize, calibrated);
    const testLabel = testInputTokens !== null && testDescription === description
      ? "Test usage at listed price" : "Estimated test";
    const fullLabel = previewMode === "full"
      ? fullInputTokens !== null ? "full run usage at listed price" : "full run estimate"
      : testInputTokens !== null && testDescription === description
        ? "estimated remaining full run, calibrated from test" : "estimated remaining full run";
    const fullCount = previewMode === "full" ? restSize.records : remainingSize.records;
    els.definitionAiCost.textContent = `${testLabel} (${sample.length}): ${formatUsd(testCost)} · ${fullLabel} (${fullCount}): ${formatUsd(fullCost)}. Estimates use current listed model pricing; OpenRouter controls the actual charge.`;
  }

  // New variables first, then leftover; least certain first within each group.
  const bySide = (a, b) => a.side === b.side ? a.confidence - b.confidence : a.side === "new" ? -1 : 1;

  function renderReviewRows(draft) {
    els.definitionAiReviewTools.hidden = false;
    els.definitionAiReviewFilter.value = reviewFilter;
    const rows = [...(reviewFilter === "spot" ? spotRows
      : reviewFilter === "all" ? preview
        : preview.filter(item => reviewFilter === "uncertain" ? item.confidence < LOW_SCORE : item.side === reviewFilter))]
      .sort(bySide);
    const pageCount = Math.max(1, Math.ceil(rows.length / REVIEW_PAGE_SIZE));
    reviewPage = Math.min(reviewPage, pageCount - 1);
    const start = reviewPage * REVIEW_PAGE_SIZE;
    const shown = rows.slice(start, start + REVIEW_PAGE_SIZE);
    els.definitionAiReviewPage.textContent = rows.length
      ? `${start + 1}–${Math.min(start + REVIEW_PAGE_SIZE, rows.length)} of ${rows.length}` : "";
    els.definitionAiReviewPrev.hidden = els.definitionAiReviewNext.hidden = pageCount <= 1;
    els.definitionAiReviewPrev.disabled = reviewPage === 0;
    els.definitionAiReviewNext.disabled = reviewPage >= pageCount - 1;
    const side = (item, value, text, verb) => h("button", { type: "button",
      className: item.side === value ? "active" : "", dataset: { aiSide: value, variableId: item.id },
      attrs: { "aria-pressed": String(item.side === value), "aria-label": `${verb} “${item.label}”` }, textContent: text });
    replaceChildren(els.definitionAiRows, shown.length ? shown.map(item => {
      const low = item.confidence < LOW_SCORE;
      return h("div", { className: `definition-ai-row${low ? " is-low" : ""}`, role: "listitem" },
        h("span", { className: "definition-ai-row-label", textContent: item.label }),
        h("span", { className: "definition-ai-row-score", title: "The model's score for its choice",
          textContent: `${low ? "Low score · " : ""}${Math.round(item.confidence * 100)}%` }),
        h("div", { className: "definition-side-buttons", role: "group", attrs: { "aria-label": `AI suggestion for ${item.label}` } },
          side(item, "new", "In", "Suggest including"), side(item, "leftover", "Out", "Suggest excluding")));
    }) : h("p", { className: "small-note", textContent: "No suggestions in this view. Choose another filter." }));
    els.definitionAiRows.querySelectorAll("button[data-ai-side]").forEach(button =>
      button.addEventListener("click", () => {
        const item = preview.find(entry => entry.id === button.dataset.variableId);
        if (item) item.side = button.dataset.aiSide;
        onPreviewChange(preview.filter(entry => entry.side === "new").map(entry => entry.id), previewMode);
        renderSummary(draft);
        renderReviewRows(draft);
      }));
  }

  function setStep(element, stepState) {
    element.dataset.state = stepState;
    if (stepState === "current" || stepState === "error") element.setAttribute("aria-current", "step");
    else element.removeAttribute("aria-current");
  }

  function render() {
    const draft = getDraft();
    const active = draft?.step === "partition";
    if (active && document.activeElement !== els.definitionAiDescription
      && els.definitionAiDescription.value !== (draft.ai_description || "")) {
      els.definitionAiDescription.value = draft.ai_description || "";
    }
    els.definitionMethodJev.disabled = busy;
    els.definitionMethodManual.disabled = busy;
    const description = String(draft?.ai_description || "").trim();
    if (active && description) void restoreForDraft().catch(() => {});
    const limitOk = Boolean(key) && keyCheck === "ok";
    const canRun = active && limitOk && !busy && description
      && [...description].length >= 20 && draft.eligible_variable_ids?.length;
    const eligibleCount = draft?.eligible_variable_ids?.length || 0;
    const sampleSize = Math.min(TEST_SIZE, eligibleCount || TEST_SIZE);
    const testSaved = completedCount("test");
    const fullSaved = completedCount("full");
    const currentTest = sampleDraft === draft && sampleSignature === eligibleSignature(draft)
      && testDescription === description && Boolean(testResults?.length);
    const showPreview = Boolean(active && currentTest && previewDraft === draft && preview?.length);
    const fullDone = showPreview && previewMode === "full";

    // 1 · Connect
    setStep(els.definitionAiStepConnect, key ? "done" : "current");
    els.definitionAiConnectSummary.textContent = key ? "Connected" : "";
    els.definitionAiConnect.hidden = Boolean(key);
    els.definitionAiDisconnect.hidden = !key || busy;

    // 2 · Spending limit: explained once, then whatever the check found.
    const limitState = !key ? "todo" : keyCheck === "ok" ? "done"
      : keyCheck === "invalid" || keyCheck === "error" ? "error" : "current";
    setStep(els.definitionAiStepLimit, limitState);
    els.definitionAiLimitSummary.textContent = limitOk && keyInfo
      ? `$${keyInfo.limit} cap · $${Number(keyInfo.limit_remaining).toFixed(2)} left` : "";
    els.definitionAiLimitText.textContent = !key
      ? "The key needs a maximum spend of $5 or less that never resets. This is checked after you connect."
      : keyCheck === "checking" ? "Checking the key's spending limit…"
        : keyCheck === "invalid" || keyCheck === "error" ? message
          : "The key needs a maximum spend of $5 or less that never resets.";
    els.definitionAiLimitText.classList.toggle("is-error", limitState === "error");
    els.definitionAiRecheck.hidden = !key || keyCheck === "ok" || keyCheck === "checking";
    replaceChildren(els.definitionAiSettingsLink, key && settingsUrl && limitState === "error"
      ? h("a", { href: settingsUrl, target: "_blank", rel: "noopener noreferrer", textContent: "Open key settings on OpenRouter ↗" }) : null);

    // 3 · Sample
    setStep(els.definitionAiStepSample, !limitOk && !currentTest ? "todo" : fullDone ? "done" : "current");
    els.definitionAiSampleSummary.textContent = currentTest ? `${testResults.length.toLocaleString()} classified` : "";
    els.definitionAiRun.hidden = currentTest && activePhase !== "test";
    els.definitionAiRun.disabled = activePhase === "test" ? false : !canRun;
    els.definitionAiRun.textContent = activePhase === "test" ? "Stop (progress is saved)"
      : testSaved && !testResults ? `Resume the sample (${testSaved} of ${sampleSize} done)`
        : `Classify a sample of ${sampleSize}`;
    const labeled = testResults?.length || 0;
    const canLabelMore = showPreview && previewMode === "test" && !fullSaved && labeled < eligibleCount;
    els.definitionAiMore.hidden = !canLabelMore && activePhase !== "more";
    els.definitionAiMore.disabled = activePhase === "more" ? false : !canRun;
    els.definitionAiMore.textContent = activePhase === "more" ? "Stop (progress is saved)"
      : sampleIds?.length > labeled ? `Resume (${completedCount("test") - labeled} of ${sampleIds.length - labeled} done)`
        : `Classify ${Math.min(TEST_SIZE, eligibleCount - labeled)} more`;
    renderCost(draft, description);
    els.definitionAiCost.hidden = !limitOk || fullDone;

    // 4 · The rest, then review and use.
    setStep(els.definitionAiStepFull, !currentTest ? "todo" : "current");
    const remaining = Math.max(0, eligibleCount - (sampleIds?.length || 0));
    els.definitionAiFullSummary.textContent = "";
    els.definitionAiFullText.textContent = !currentTest ? "Available after the sample."
      : fullDone ? "Check the suggestions below, then use them. Your choices don't change until you do."
        : `The AI classifies the other ${remaining.toLocaleString()} concepts. You review its suggestions before they are used.`;
    els.definitionAiFullRun.hidden = !currentTest || fullDone;
    els.definitionAiFullRun.disabled = activePhase === "full" ? false : !canRun;
    els.definitionAiFullRun.textContent = activePhase === "full" ? "Stop (progress is saved)" : fullSaved
      ? `Resume (${fullSaved} of ${remaining} done)` : `Classify the remaining ${remaining.toLocaleString()} concepts`;
    const manualChoices = draft?.reviewed_variable_ids?.length || 0;
    els.definitionAiApply.hidden = !fullDone;
    els.definitionAiApply.disabled = busy;
    els.definitionAiApply.textContent = manualChoices ? "Replace my choices with these suggestions" : "Use these suggestions";
    els.definitionAiApplyNote.hidden = !fullDone || !manualChoices;
    els.definitionAiApplyNote.textContent = `This replaces your ${manualChoices.toLocaleString()} existing choices: concepts suggested In become included and all others excluded. You can undo it in Choose manually.`;
    els.definitionAiDiscard.hidden = !showPreview || busy;

    // Progress and errors sit with the step they belong to.
    const statusHost = !key ? (message ? els.definitionAiStepConnect.querySelector(".definition-ai-step-body") : null)
      : limitState === "error" || keyCheck === "checking" ? null
      : activePhase === "full" || fullSaved || fullDone ? els.definitionAiFullHost : els.definitionAiSampleHost;
    const statusText = statusHost ? message : "";
    els.definitionAiStatus.textContent = statusText;
    els.definitionAiStatus.hidden = !statusText;
    if (statusHost && els.definitionAiStatus.parentElement !== statusHost) statusHost.prepend(els.definitionAiStatus);
    const previewHost = previewMode === "full" ? els.definitionAiFullHost : els.definitionAiSampleHost;
    if (els.definitionAiPreview.parentElement !== previewHost) previewHost.append(els.definitionAiPreview);
    els.definitionAiPreview.hidden = !showPreview;
    if (!showPreview) return;
    renderSummary(draft);
    renderReviewRows(draft);
  }

  async function checkKey(signal) {
    if (!key) return false;
    keyInfo = null;
    keyCheck = "checking";
    onConnectionChange(false);
    render();
    let body;
    try {
      body = await openRouterJson("/api/v1/key", key, { signal });
    } catch (error) {
      // A failed check says nothing about the key; it can simply be retried.
      keyCheck = "error";
      message = `Could not check the limit: ${error.message}. Try again.`;
      render();
      throw error;
    }
    keyInfo = body.data;
    const problem = cappedKeyStatus(keyInfo);
    pricing = null;
    if (!problem) {
      try {
        const model = await openRouterJson(`/api/v1/model/${MODEL}`, key, { signal });
        pricing = parseJevPricing(model.data?.pricing);
      } catch { /* The split can still run if pricing is temporarily unavailable. */ }
    }
    if (signal?.aborted) return false;
    keyCheck = problem ? "invalid" : "ok";
    message = problem || "";
    render();
    onConnectionChange(!problem);
    return !problem;
  }

  async function connect() {
    if (!getDraft()) return;
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
    const challenge = await sha256Base64Url(verifier);
    sessionStorage.setItem(OAUTH_PENDING_KEY, JSON.stringify({ verifier, state }));
    sessionStorage.setItem(OAUTH_DRAFT_KEY, JSON.stringify(getDraft()));
    persistDraft();
    const url = new URL("https://openrouter.ai/auth");
    const callback = new URL(getReturnUrl());
    callback.searchParams.delete("code");
    callback.searchParams.delete("state");
    // Keep the exact viewer URL locally as a fallback. OpenRouter normally
    // echoes callback_url, but a provider redirect must not be able to drop
    // the immutable dataset binding from the viewer permalink.
    sessionStorage.setItem(OAUTH_RETURN_URL_KEY, callback.href);
    url.searchParams.set("callback_url", callback.href);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("key_label", "Echo variable split");
    url.searchParams.set("state", state);
    location.assign(url.href);
  }

  async function finishConnection() {
    const url = new URL(location.href);
    const code = url.searchParams.get("code");
    if (!code) return;
    const returnedState = url.searchParams.get("state");
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    const savedReturnUrl = sessionStorage.getItem(OAUTH_RETURN_URL_KEY);
    sessionStorage.removeItem(OAUTH_RETURN_URL_KEY);
    let returnUrl = url.href;
    if (savedReturnUrl) {
      try {
        const candidate = new URL(savedReturnUrl);
        // Only restore a same-origin viewer URL captured by this tab. This
        // keeps the fallback from becoming an open redirect.
        if (candidate.origin === location.origin && candidate.pathname === location.pathname) {
          returnUrl = candidate.href;
        }
      } catch { /* Ignore a malformed saved URL and use the callback URL. */ }
    }
    history.replaceState(history.state, "", returnUrl);
    const pending = JSON.parse(sessionStorage.getItem(OAUTH_PENDING_KEY) || "null");
    sessionStorage.removeItem(OAUTH_PENDING_KEY);
    if (!pending || pending.state !== returnedState) {
      message = "OpenRouter authorization could not be verified. Connect again.";
      render();
      return;
    }
    try {
      const body = await openRouterJson("/api/v1/auth/keys", null, {
        method: "POST", body: JSON.stringify({ code, code_verifier: pending.verifier, code_challenge_method: "S256" }),
      });
      if (typeof body.key !== "string" || !body.key) throw new Error("OpenRouter did not return a key.");
      key = body.key;
      settingsUrl = await keySettingsUrl(key);
      await checkKey();
    } catch (error) {
      key = null;
      message = `Could not connect OpenRouter: ${error.message}`;
      render();
      onConnectionChange(false);
    }
  }

  function showProgress(value) {
    message = value;
    const statusText = els.definitionAiStatus.querySelector("span");
    if (statusText) statusText.textContent = value;
  }

  function stopRun() {
    if (!busy) return;
    runRevision += 1;
    activeRequest?.abort("stopped");
    showProgress(`Stopped. ${completedCount(activePhase === "full" ? "full" : "test")} completed variables are saved in this browser. You can resume this run.`);
  }

  async function classify(ids, description, draft, revision, phase, base = 0) {
    const records = recordsFor(ids);
    const name = phase === "test" ? (base ? "Labeling" : "Test") : "Full";
    const results = [];
    let inputTokens = 0;
    let usageComplete = true;
    for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
      if (revision !== runRevision || draft !== getDraft()) return null;
      const batch = records.slice(offset, offset + BATCH_SIZE);
      let saved = phaseBatches(phase).find(item => item.offset === base + offset);
      if (saved && (saved.results.length !== batch.length
        || saved.results.some((item, index) => item.id !== batch[index].id))) {
        throw new Error("Saved classification progress does not match these source variables.");
      }
      if (!saved) {
        showProgress(`${name} run: requesting variables ${offset + 1}–${Math.min(offset + BATCH_SIZE, records.length)} of ${records.length}…`);
        const body = await openRouterJson("/api/alpha/decisions", key, { method: "POST",
          body: JSON.stringify(requestFor(batch, description)), signal: activeRequest.signal });
        if (revision !== runRevision || draft !== getDraft()) return null;
        const rows = jevResults(body, batch);
        const reportedTokens = Number(body.usage?.input_tokens ?? body.usage?.inputTokens);
        const tokens = Number.isFinite(reportedTokens) && reportedTokens >= 0 ? reportedTokens : null;
        showProgress(`${name} run: saving variables ${offset + 1}–${Math.min(offset + BATCH_SIZE, records.length)} in this browser…`);
        const runId = checkpoint.run.id;
        await saveJevBatch(runId, phase, base + offset, rows, tokens);
        saved = { offset: base + offset, phase, results: rows, inputTokens: tokens };
        if (checkpoint?.run.id === runId) checkpoint.batches.push(saved);
        if (revision !== runRevision || draft !== getDraft()) return null;
      }
      results.push(...saved.results);
      if (saved.inputTokens === null) usageComplete = false;
      else inputTokens += saved.inputTokens;
      showProgress(`${name} run: ${Math.min(offset + BATCH_SIZE, records.length)} of ${records.length} variables saved in this browser…`);
    }
    return { results, inputTokens: usageComplete ? inputTokens : null };
  }

  async function runTest() {
    const draft = getDraft();
    if (!draft || draft.step !== "partition" || !key || busy || !draft.eligible_variable_ids?.length) return;
    const description = String(draft.ai_description || "").trim();
    if ([...description].length < 20) return;
    const revision = ++runRevision;
    busy = true;
    activePhase = "test";
    activeRequest = new AbortController();
    preview = null;
    previewDraft = null;
    previewMode = null;
    testResults = null;
    testDescription = null;
    testInputTokens = null;
    fullInputTokens = null;
    spotRows = [];
    reviewFilter = "all";
    reviewPage = 0;
    onPreviewChange(null);
    message = "Checking the key limit…";
    render();
    try {
      if (!await checkKey(activeRequest.signal) || revision !== runRevision || draft !== getDraft()) return;
      showProgress("Preparing local checkpoint…");
      if (!await ensureCheckpoint(draft, description)
        || revision !== runRevision || draft !== getDraft()) return;
      const outcome = await classify(ensureSample(draft), description, draft, revision, "test");
      if (!outcome || revision !== runRevision || draft !== getDraft()) return;
      testResults = outcome.results;
      testInputTokens = outcome.inputTokens;
      testDescription = description;
      preview = outcome.results;
      previewDraft = draft;
      previewMode = "test";
      spotRows = spotCheckResults(preview);
      onPreviewChange(preview.filter(item => item.side === "new").map(item => item.id), "test");
      message = "";
    } catch (error) {
      if (revision === runRevision) message = `Test paused: ${error.message} Completed batches are saved in this browser. Resume the test when ready.`;
    } finally {
      busy = false;
      activePhase = null;
      activeRequest = null;
      render();
    }
  }

  // Label the next round of variables and append it to the list. A round that
  // was interrupted keeps its saved ids, so resuming never relabels a sample.
  async function runMore() {
    const draft = getDraft();
    const description = String(draft?.ai_description || "").trim();
    if (!draft || draft.step !== "partition" || !key || busy || !testResults?.length || previewMode !== "test"
      || sampleDraft !== draft || sampleSignature !== eligibleSignature(draft)
      || testDescription !== description || completedCount("full")
      || testResults.length >= draft.eligible_variable_ids.length) return;
    const revision = ++runRevision;
    busy = true;
    activePhase = "more";
    activeRequest = new AbortController();
    message = "Checking the key limit…";
    render();
    try {
      if (!await checkKey(activeRequest.signal) || revision !== runRevision || draft !== getDraft()) return;
      showProgress("Preparing local checkpoint…");
      if (!await ensureCheckpoint(draft, description)
        || revision !== runRevision || draft !== getDraft()) return;
      const labeled = testResults.length;
      if (sampleIds.length <= labeled) {
        const taken = new Set(sampleIds);
        sampleIds = [...sampleIds, ...randomSampleIds(draft.eligible_variable_ids.filter(id => !taken.has(id)), TEST_SIZE)];
        costCache = null;
        checkpoint.run.sampleIds = sampleIds;
        await saveJevRun(checkpoint.run);
        if (revision !== runRevision || draft !== getDraft()) return;
      }
      const outcome = await classify(sampleIds.slice(labeled, labeled + TEST_SIZE), description, draft, revision, "test", labeled);
      if (!outcome || revision !== runRevision || draft !== getDraft()) return;
      testResults = [...testResults, ...outcome.results];
      testInputTokens = testInputTokens === null || outcome.inputTokens === null ? null : testInputTokens + outcome.inputTokens;
      preview = testResults;
      spotRows = spotCheckResults(preview);
      onPreviewChange(preview.filter(item => item.side === "new").map(item => item.id), "test");
      message = "";
    } catch (error) {
      if (revision === runRevision) message = `Labeling paused: ${error.message} Completed batches are saved in this browser. Resume when ready.`;
    } finally {
      busy = false;
      activePhase = null;
      activeRequest = null;
      render();
    }
  }

  async function runFull() {
    const draft = getDraft();
    const description = String(draft?.ai_description || "").trim();
    if (!draft || draft.step !== "partition" || !key || busy || !testResults?.length
      || sampleDraft !== draft || sampleSignature !== eligibleSignature(draft)
      || testDescription !== description) return;
    const revision = ++runRevision;
    busy = true;
    activePhase = "full";
    activeRequest = new AbortController();
    message = "Checking the key limit…";
    render();
    try {
      if (!await checkKey(activeRequest.signal) || revision !== runRevision || draft !== getDraft()) return;
      showProgress("Preparing local checkpoint…");
      if (!await ensureCheckpoint(draft, description)
        || revision !== runRevision || draft !== getDraft()) return;
      const sampled = new Set(sampleIds);
      const remaining = draft.eligible_variable_ids.filter(id => !sampled.has(id));
      const outcome = await classify(remaining, description, draft, revision, "full");
      if (!outcome || revision !== runRevision || draft !== getDraft()) return;
      fullInputTokens = outcome.inputTokens;
      preview = [...testResults, ...outcome.results];
      previewDraft = draft;
      previewMode = "full";
      spotRows = spotCheckResults(preview);
      reviewFilter = "spot";
      reviewPage = 0;
      onPreviewChange(preview.filter(item => item.side === "new").map(item => item.id), "full");
      message = "";
    } catch (error) {
      if (revision === runRevision) message = `Full run paused: ${error.message} ${completedCount("full")} completed variables are saved in this browser. Resume when ready.`;
    } finally {
      busy = false;
      activePhase = null;
      activeRequest = null;
      render();
    }
  }

  function install() {
    els.definitionAiDescription.addEventListener("input", () => {
      const draft = getDraft();
      if (!draft) return;
      draft.ai_description = els.definitionAiDescription.value;
      persistDraft();
      message = "Description changed. Test this same sample again before running the full split.";
      clearPreview({ keepSample: true });
    });
    els.definitionAiConnect.addEventListener("click", () => void connect());
    els.definitionAiRecheck.addEventListener("click", () => {
      void checkKey().catch(error => {
        message = `Could not check this key: ${error.message}`;
        render();
      });
    });
    els.definitionAiDisconnect.addEventListener("click", () => {
      key = null; keyInfo = null; pricing = null; keyCheck = "idle";
      onConnectionChange(false);
      message = "";
      clearPreview({ keepCheckpoint: true });
    });
    els.definitionAiRun.addEventListener("click", () => activePhase === "test" ? stopRun() : void runTest());
    els.definitionAiFullRun.addEventListener("click", () => activePhase === "full" ? stopRun() : void runFull());
    els.definitionAiMore.addEventListener("click", () => activePhase === "more" ? stopRun() : void runMore());
    els.definitionAiReviewFilter.addEventListener("change", () => {
      reviewFilter = els.definitionAiReviewFilter.value;
      reviewPage = 0;
      if (preview && previewDraft === getDraft()) renderReviewRows(previewDraft);
    });
    els.definitionAiReviewPrev.addEventListener("click", () => {
      reviewPage = Math.max(0, reviewPage - 1);
      if (preview && previewDraft === getDraft()) renderReviewRows(previewDraft);
    });
    els.definitionAiReviewNext.addEventListener("click", () => {
      reviewPage += 1;
      if (preview && previewDraft === getDraft()) renderReviewRows(previewDraft);
    });
    els.definitionAiApply.addEventListener("click", () => {
      if (!preview || busy || previewMode !== "full" || previewDraft !== getDraft()) return;
      onApply(preview.filter(item => item.side === "new").map(item => item.id), testDescription);
      clearPreview();
    });
    els.definitionAiDiscard.addEventListener("click", clearPreview);
    void finishConnection();
  }

  function takeResumeDraft() {
    const saved = sessionStorage.getItem(OAUTH_DRAFT_KEY);
    sessionStorage.removeItem(OAUTH_DRAFT_KEY);
    if (!saved) return null;
    try { return JSON.parse(saved); } catch { return null; }
  }

  return { install, render, clearPreview, takeResumeDraft, restoreForDraft,
    listSavedRuns: listJevRuns, discardSavedRun: deleteJevRun };
}
