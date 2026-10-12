import { h, replaceChildren } from "./dom_builder.mjs";
import { jevRunId, loadJevRun, latestJevRun, saveJevRun, saveJevBatch, deleteJevRun } from "./definition_jev_checkpoint.mjs";

const MODEL = "typesafe/jev-1.13";
const MAX_KEY_LIMIT_USD = 5;
const OAUTH_PENDING_KEY = "echo-openrouter-pkce-v1";
const OAUTH_DRAFT_KEY = "echo-openrouter-definition-draft-v1";
const BATCH_SIZE = 16;
const TEST_SIZE = 24;
const CHARS_PER_TOKEN = 4;
const REVIEW_PAGE_SIZE = 40;
const SPOT_CHECK_PER_GROUP = 12;
const REQUEST_TIMEOUT_MS = 60_000;

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

export function randomSampleIds(sourceIds, count = TEST_SIZE) {
  const ids = [...sourceIds];
  const random = new Uint32Array(ids.length);
  // Browsers cap each getRandomValues call at 65,536 bytes.
  for (let offset = 0; offset < random.length; offset += 16_384) {
    crypto.getRandomValues(random.subarray(offset, offset + 16_384));
  }
  for (let index = ids.length - 1; index > 0; index -= 1) {
    const swap = random[index] % (index + 1);
    [ids[index], ids[swap]] = [ids[swap], ids[index]];
  }
  return ids.slice(0, count);
}

function formatUsd(amount) {
  return amount > 0 && amount < 0.000001 ? "<$0.000001" : `$${amount.toFixed(6)}`;
}

function parsePricing(data) {
  const values = [data?.prompt, data?.completion, data?.request ?? 0].map(Number);
  if (values.some(value => !Number.isFinite(value) || value < 0)) return null;
  return { input: values[0], output: values[1], request: values[2] };
}

export function cappedKeyStatus(data) {
  if (!data || !Number.isFinite(data.limit) || data.limit < 0) {
    return "Set a spending limit of $5 or less on this OpenRouter key.";
  }
  if (data.limit > MAX_KEY_LIMIT_USD) {
    return `This key allows $${data.limit} of spending. Lower its limit to $5 or less.`;
  }
  if (data.limit_reset !== null) {
    return "Choose a limit that never resets, rather than a daily, weekly, or monthly limit.";
  }
  if (!Number.isFinite(data.limit_remaining) || data.limit_remaining <= 0) {
    return "This key has no spending allowance left. Connect a new capped key.";
  }
  return null;
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

async function openRouterJson(path, key, options = {}) {
  const { signal, ...fetchOptions } = options;
  const controller = new AbortController();
  const stop = () => controller.abort(signal.reason);
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`https://openrouter.ai${path}`, {
      ...fetchOptions, signal: controller.signal,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}) },
    });
    const body = await response.json().catch(error => {
      if (controller.signal.aborted) throw error;
      return {};
    });
    if (!response.ok) throw new Error(body.error?.message || body.message || `OpenRouter returned ${response.status}.`);
    return body;
  } catch (error) {
    if (controller.signal.reason === "timeout") {
      throw new Error("OpenRouter did not respond within 60 seconds.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

export function createDefinitionJevAssist({ elements: els, getDraft, getVariable, onApply,
  onPreviewChange = () => {}, persistDraft }) {
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
  let message = "Connect OpenRouter, then set a $5 lifetime cap on the key it creates.";
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
    reviewFilter = "spot";
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
      role: draft.role, split_id: draft.split_id || null,
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

  function savedPhase(ids, phase) {
    const batches = new Map(phaseBatches(phase).map(batch => [batch.offset, batch]));
    const results = [];
    let inputTokens = 0;
    let usageComplete = true;
    for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
      const batch = batches.get(offset);
      const expected = ids.slice(offset, offset + BATCH_SIZE);
      if (!batch || batch.results.length !== expected.length
        || batch.results.some((item, index) => item.id !== expected[index])) return null;
      results.push(...batch.results);
      if (batch.inputTokens === null) usageComplete = false;
      else inputTokens += batch.inputTokens;
    }
    return { results, inputTokens: usageComplete ? inputTokens : null };
  }

  function restorePreview(draft, description) {
    const sample = checkpoint?.run.sampleIds;
    if (!Array.isArray(sample) || sample.length !== Math.min(TEST_SIZE, draft.eligible_variable_ids.length)
      || new Set(sample).size !== sample.length
      || sample.some(id => !draft.eligible_variable_ids.includes(id))) {
      throw new Error("Saved AI sample does not match these source variables.");
    }
    costCache = null;
    sampleDraft = draft;
    sampleSignature = eligibleSignature(draft);
    sampleIds = sample;
    const test = savedPhase(sample, "test");
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
    spotRows = full ? spotCheckResults(preview) : [];
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
    const uncertain = preview.filter(item => item.confidence < 0.65).length;
    const counts = `${newCount} suggested for new · ${preview.length - newCount} leftover · ${uncertain} lower-score choices.`;
    els.definitionAiSummary.textContent = previewMode === "test"
      ? `Tested ${preview.length} of ${draft.eligible_variable_ids.length} variables. ${counts} This is a preview; your draft has not changed. Review the choices, then revise the description or run the full split.`
      : `${counts} This is a preview; your draft has not changed. Spot check the choices, then use them in your draft. Every choice is included, even those not shown here.`;
  }

  function recordsFor(ids) {
    return ids.map(id => {
      const variable = getVariable(id) || {};
      return { id, label: String(variable.display_label || variable.concept_label || id).slice(0, 300),
        text: String(variable.raw_variable_text || variable.concept_label || "").slice(0, 600) };
    });
  }

  function requestFor(batch, description) {
    const questions = Object.fromEntries(batch.map((record, index) => [`v${index}`, {
      type: "choice", instructions: `Classify the source variable at records[${index}] using its label and text. Choose new only when it clearly fits target_definition. Leftover is the remainder of the selected source variables, not a separately defined opposite concept. Put uncertain or ambiguous matches in leftover for human review.`,
      criteria: { new: "Clearly belongs in the new variable described by target_definition",
        leftover: "Does not clearly belong in the new variable described by target_definition, including uncertain matches" },
    }]));
    return { model: MODEL,
      state: { target_definition: description, records: batch.map(({ label, text }) => ({ label, text })) },
      questions };
  }

  function requestSizes(ids, description) {
    const records = recordsFor(ids);
    let inputTokens = 0;
    let requests = 0;
    for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
      inputTokens += Math.ceil(JSON.stringify(requestFor(records.slice(offset, offset + BATCH_SIZE), description)).length / CHARS_PER_TOKEN);
      requests += 1;
    }
    return { inputTokens, requests, records: records.length };
  }

  function estimatedCharge(size, calibration = 1) {
    // Jev currently charges for input tokens; include a small output allowance if that pricing changes.
    const outputTokens = size.records * 8;
    return (size.inputTokens * calibration * pricing.input) + (outputTokens * pricing.output)
      + (size.requests * pricing.request);
  }

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

  function renderReviewRows(draft) {
    const full = previewMode === "full";
    els.definitionAiReviewTools.hidden = !full;
    let rows = preview;
    if (full) {
      els.definitionAiReviewFilter.value = reviewFilter;
      rows = reviewFilter === "spot" ? spotRows
        : reviewFilter === "all" ? preview
          : preview.filter(item => reviewFilter === "uncertain" ? item.confidence < 0.65 : item.side === reviewFilter);
      if (reviewFilter !== "spot") rows = [...rows].sort((a, b) => a.confidence - b.confidence);
    } else rows = [...rows].sort((a, b) => a.confidence - b.confidence);
    const pageCount = Math.max(1, Math.ceil(rows.length / REVIEW_PAGE_SIZE));
    reviewPage = Math.min(reviewPage, pageCount - 1);
    const start = reviewPage * REVIEW_PAGE_SIZE;
    const shown = full ? rows.slice(start, start + REVIEW_PAGE_SIZE) : rows;
    els.definitionAiReviewPage.textContent = full
      ? `${rows.length ? start + 1 : 0}–${Math.min(start + REVIEW_PAGE_SIZE, rows.length)} of ${rows.length}` : "";
    els.definitionAiReviewPrev.disabled = reviewPage === 0;
    els.definitionAiReviewNext.disabled = reviewPage >= pageCount - 1;
    replaceChildren(els.definitionAiRows, shown.length ? shown.map(item => h("div", { className: "definition-ai-row" },
      h("span", { textContent: `${item.label} · ${Math.round(item.confidence * 100)}% model score` }),
      !full ? h("span", { className: "definition-ai-side", textContent: item.side === "new" ? "New variable" : "Leftover" })
        : h("select", { dataset: { variableId: item.id }, attrs: { "aria-label": `Side for ${item.label}` } },
          h("option", { value: "new", textContent: "New variable", selected: item.side === "new" }),
          h("option", { value: "leftover", textContent: "Leftover", selected: item.side === "leftover" }))))
      : h("div", { className: "small-note", textContent: "No results in this view. Choose another filter to inspect more." }));
    els.definitionAiRows.querySelectorAll("select[data-variable-id]").forEach(select =>
      select.addEventListener("change", () => {
        const item = preview.find(entry => entry.id === select.dataset.variableId);
        if (item) item.side = select.value;
        onPreviewChange(preview.filter(entry => entry.side === "new").map(entry => entry.id), previewMode);
        renderSummary(draft);
        renderReviewRows(draft);
      }));
  }

  function render() {
    const draft = getDraft();
    const active = draft?.step === "partition";
    if (active && els.definitionAiDescription.value !== (draft.ai_description || "")) {
      els.definitionAiDescription.value = draft.ai_description || "";
    }
    els.definitionAiConnect.hidden = Boolean(key);
    els.definitionAiRecheck.hidden = !key;
    els.definitionAiDisconnect.hidden = !key;
    els.definitionMethodJev.disabled = busy;
    els.definitionMethodManual.disabled = busy;
    const description = String(draft?.ai_description || "").trim();
    if (active && description) void restoreForDraft().catch(() => {});
    const canRun = active && key && !cappedKeyStatus(keyInfo) && !busy && description
      && draft.eligible_variable_ids?.length;
    els.definitionAiRun.disabled = activePhase === "test" ? false : !canRun;
    const testSaved = completedCount("test");
    const fullSaved = completedCount("full");
    els.definitionAiRun.textContent = activePhase === "test" ? "Stop test (save progress)"
      : testSaved && !testResults ? `Resume test (${testSaved}/${Math.min(TEST_SIZE, draft?.eligible_variable_ids?.length || TEST_SIZE)} saved)`
        : testResults ? `Review saved ${Math.min(TEST_SIZE, draft?.eligible_variable_ids?.length || TEST_SIZE)}-variable test`
          : `Test split on ${Math.min(TEST_SIZE, draft?.eligible_variable_ids?.length || TEST_SIZE)} variables`;
    replaceChildren(els.definitionAiStatus, h("span", { textContent: message }),
      settingsUrl ? h("a", { href: settingsUrl, target: "_blank", rel: "noopener noreferrer",
        textContent: "Open key settings" }) : null);
    renderCost(draft, description);
    const currentTest = sampleDraft === draft && sampleSignature === eligibleSignature(draft)
      && testDescription === description && Boolean(testResults?.length);
    const showPreview = active && currentTest && previewDraft === draft && preview?.length;
    els.definitionAiPreview.hidden = !showPreview;
    els.definitionAiFullRun.hidden = !showPreview || previewMode !== "test";
    els.definitionAiFullRun.disabled = activePhase === "full" ? false : !canRun;
    els.definitionAiFullRun.textContent = activePhase === "full" ? "Stop full run (save progress)" : fullSaved
      ? `Resume full split (${fullSaved}/${Math.max(0, (draft?.eligible_variable_ids?.length || 0) - (sampleIds?.length || 0))} saved)`
      : "Run full split";
    els.definitionAiApply.hidden = !showPreview || previewMode !== "full";
    if (!showPreview) return;
    renderSummary(draft);
    renderReviewRows(draft);
  }

  async function checkKey(signal) {
    if (!key) return false;
    keyInfo = null;
    render();
    const body = await openRouterJson("/api/v1/key", key, { signal });
    keyInfo = body.data;
    const problem = cappedKeyStatus(keyInfo);
    pricing = null;
    if (!problem) {
      try {
        const model = await openRouterJson(`/api/v1/model/${MODEL}`, key, { signal });
        pricing = parsePricing(model.data?.pricing);
      } catch { /* The split can still run if pricing is temporarily unavailable. */ }
    }
    if (signal?.aborted) return false;
    message = problem || `Connected. This key has a $${keyInfo.limit} non-resetting cap and $${Number(keyInfo.limit_remaining).toFixed(2)} remaining.`;
    render();
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
    const callback = new URL(location.href);
    callback.searchParams.delete("code");
    callback.searchParams.delete("state");
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
    history.replaceState(history.state, "", url.href);
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
    showProgress(`Stopped. ${completedCount(activePhase)} completed variables are saved in this browser. You can resume this run.`);
  }

  async function classify(ids, description, draft, revision, phase) {
    const records = recordsFor(ids);
    const results = [];
    let inputTokens = 0;
    let usageComplete = true;
    for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
      if (revision !== runRevision || draft !== getDraft()) return null;
      const batch = records.slice(offset, offset + BATCH_SIZE);
      let saved = phaseBatches(phase).find(item => item.offset === offset);
      if (saved && (saved.results.length !== batch.length
        || saved.results.some((item, index) => item.id !== batch[index].id))) {
        throw new Error("Saved classification progress does not match these source variables.");
      }
      if (!saved) {
        showProgress(`${phase === "test" ? "Test" : "Full"} run: requesting variables ${offset + 1}–${Math.min(offset + BATCH_SIZE, records.length)} of ${records.length}…`);
        const body = await openRouterJson("/api/alpha/decisions", key, { method: "POST",
          body: JSON.stringify(requestFor(batch, description)), signal: activeRequest.signal });
        if (revision !== runRevision || draft !== getDraft()) return null;
        const rows = [];
        for (const [index, record] of batch.entries()) {
          const answer = body.answers?.[`v${index}`];
          if (answer?.type !== "choice" || !["new", "leftover"].includes(answer.choice)) {
            throw new Error("The model returned an incomplete classification. Completed batches remain saved.");
          }
          const probability = Number(answer.probabilities?.[answer.choice] ?? answer.confidence ?? 0);
          rows.push({ id: record.id, label: record.label, side: answer.choice,
            confidence: Number.isFinite(probability) ? Math.max(0, Math.min(1, probability)) : 0 });
        }
        const reportedTokens = Number(body.usage?.input_tokens ?? body.usage?.inputTokens);
        const tokens = Number.isFinite(reportedTokens) && reportedTokens >= 0 ? reportedTokens : null;
        showProgress(`${phase === "test" ? "Test" : "Full"} run: saving variables ${offset + 1}–${Math.min(offset + BATCH_SIZE, records.length)} in this browser…`);
        const runId = checkpoint.run.id;
        await saveJevBatch(runId, phase, offset, rows, tokens);
        saved = { offset, phase, results: rows, inputTokens: tokens };
        if (checkpoint?.run.id === runId) checkpoint.batches.push(saved);
        if (revision !== runRevision || draft !== getDraft()) return null;
      }
      results.push(...saved.results);
      if (saved.inputTokens === null) usageComplete = false;
      else inputTokens += saved.inputTokens;
      showProgress(`${phase === "test" ? "Test" : "Full"} run: ${Math.min(offset + BATCH_SIZE, records.length)} of ${records.length} variables saved in this browser…`);
    }
    return { results, inputTokens: usageComplete ? inputTokens : null };
  }

  async function runTest() {
    const draft = getDraft();
    if (!draft || draft.step !== "partition" || !key || busy || !draft.eligible_variable_ids?.length) return;
    const description = String(draft.ai_description || "").trim();
    if (!description) return;
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
    reviewFilter = "spot";
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
      onPreviewChange(preview.filter(item => item.side === "new").map(item => item.id), "test");
      message = "Test ready. Review the sample, then revise the description or run the full split.";
    } catch (error) {
      if (revision === runRevision) message = `Test paused: ${error.message} Completed batches are saved in this browser. Resume the test when ready.`;
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
      message = "Full suggestions ready. Review them before applying.";
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
      key = null; keyInfo = null; pricing = null;
      message = "Disconnected from OpenRouter in this tab. You can revoke the key in OpenRouter.";
      clearPreview({ keepCheckpoint: true });
    });
    els.definitionAiRun.addEventListener("click", () => activePhase === "test" ? stopRun() : void runTest());
    els.definitionAiFullRun.addEventListener("click", () => activePhase === "full" ? stopRun() : void runFull());
    els.definitionAiReviewFilter.addEventListener("change", () => {
      reviewFilter = els.definitionAiReviewFilter.value;
      reviewPage = 0;
      if (previewMode === "full" && previewDraft === getDraft()) renderReviewRows(previewDraft);
    });
    els.definitionAiReviewPrev.addEventListener("click", () => {
      reviewPage = Math.max(0, reviewPage - 1);
      if (previewMode === "full" && previewDraft === getDraft()) renderReviewRows(previewDraft);
    });
    els.definitionAiReviewNext.addEventListener("click", () => {
      reviewPage += 1;
      if (previewMode === "full" && previewDraft === getDraft()) renderReviewRows(previewDraft);
    });
    els.definitionAiApply.addEventListener("click", () => {
      if (!preview || previewMode !== "full" || previewDraft !== getDraft()) return;
      onApply(preview.filter(item => item.side === "new").map(item => item.id));
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
    latestResumeDraft: async () => (await latestJevRun())?.draft || null };
}
