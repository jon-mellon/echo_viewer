import { h, replaceChildren } from "./dom_builder.mjs";

const MODEL = "typesafe/jev-1.13";
const MAX_KEY_LIMIT_USD = 5;
const OAUTH_PENDING_KEY = "echo-openrouter-pkce-v1";
const OAUTH_DRAFT_KEY = "echo-openrouter-definition-draft-v1";
const BATCH_SIZE = 16;
const TEST_SIZE = 24;
const CHARS_PER_TOKEN = 4;
const REVIEW_PAGE_SIZE = 40;
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
  const response = await fetch(`https://openrouter.ai${path}`, {
    ...options,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || body.message || `OpenRouter returned ${response.status}.`);
  return body;
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
  let message = "Connect OpenRouter, then set a $5 lifetime cap on the key it creates.";
  let runRevision = 0;

  function eligibleSignature(draft) {
    return (draft?.eligible_variable_ids || []).join("\u0000");
  }

  function clearPreview({ keepSample = false } = {}) {
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
    const ids = [...draft.eligible_variable_ids];
    const random = crypto.getRandomValues(new Uint32Array(ids.length));
    for (let index = ids.length - 1; index > 0; index -= 1) {
      const swap = random[index] % (index + 1);
      [ids[index], ids[swap]] = [ids[swap], ids[index]];
    }
    sampleDraft = draft;
    sampleSignature = signature;
    sampleIds = ids.slice(0, TEST_SIZE);
    return sampleIds;
  }

  function renderSummary(draft) {
    const newCount = preview.filter(item => item.side === "new").length;
    const uncertain = preview.filter(item => item.confidence < 0.65).length;
    const counts = `${newCount} suggested for new · ${preview.length - newCount} leftover · ${uncertain} lower-score choices.`;
    els.definitionAiSummary.textContent = previewMode === "test"
      ? `Tested ${preview.length} of ${draft.eligible_variable_ids.length} variables. ${counts} Review the choices, then revise the description and retest this sample or run the full split.`
      : `${counts} Spot check suggestions and inspect lower-score choices. You can page through all results; applying uses every suggestion, including those not shown here.`;
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
      els.definitionAiCost.textContent = "Cost estimate unavailable. Check Jev pricing on OpenRouter before running.";
      return;
    }
    const sample = ensureSample(draft);
    const signature = eligibleSignature(draft);
    if (!costCache || costCache.draft !== draft || costCache.signature !== signature
      || costCache.description !== description) {
      const sampled = new Set(sample);
      const rest = draft.eligible_variable_ids.filter(id => !sampled.has(id));
      costCache = { draft, signature, description, testSize: requestSizes(sample, description),
        restSize: requestSizes(rest, description) };
    }
    const { testSize, restSize } = costCache;
    const calibrated = testInputTokens !== null && testDescription === description
      && testSize.inputTokens > 0 ? testInputTokens / testSize.inputTokens : 1;
    const testCost = testInputTokens !== null && testDescription === description
      ? estimatedCharge({ ...testSize, inputTokens: testInputTokens }, 1)
      : estimatedCharge(testSize);
    const fullCost = fullInputTokens !== null && previewMode === "full"
      ? estimatedCharge({ ...restSize, inputTokens: fullInputTokens })
      : estimatedCharge(restSize, calibrated);
    const testLabel = testInputTokens !== null && testDescription === description
      ? "Test usage at listed price" : "Estimated test";
    const fullLabel = previewMode === "full"
      ? fullInputTokens !== null ? "full run usage at listed price" : "full run estimate"
      : testInputTokens !== null && testDescription === description
        ? "estimated remaining full run, calibrated from test" : "estimated remaining full run";
    els.definitionAiCost.textContent = `${testLabel} (${sample.length}): ${formatUsd(testCost)} · ${fullLabel} (${restSize.records}): ${formatUsd(fullCost)}. Estimates use current listed Jev pricing; OpenRouter controls the actual charge.`;
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
    const description = String(draft?.ai_description || "").trim();
    const canRun = active && key && !cappedKeyStatus(keyInfo) && !busy && description
      && draft.eligible_variable_ids?.length;
    els.definitionAiRun.disabled = !canRun;
    els.definitionAiRun.textContent = busy ? "Classifying variables…"
      : `${testResults ? "Rerun test on" : "Test split on"} ${Math.min(TEST_SIZE, draft?.eligible_variable_ids?.length || TEST_SIZE)} variables`;
    replaceChildren(els.definitionAiStatus, h("span", { textContent: message }),
      settingsUrl ? h("a", { href: settingsUrl, target: "_blank", rel: "noopener noreferrer",
        textContent: "Open key settings" }) : null);
    renderCost(draft, description);
    const currentTest = sampleDraft === draft && sampleSignature === eligibleSignature(draft)
      && testDescription === description && Boolean(testResults?.length);
    const showPreview = active && currentTest && previewDraft === draft && preview?.length;
    els.definitionAiPreview.hidden = !showPreview;
    els.definitionAiFullRun.hidden = !showPreview || previewMode !== "test";
    els.definitionAiFullRun.disabled = !canRun;
    els.definitionAiApply.hidden = !showPreview || previewMode !== "full";
    if (!showPreview) return;
    renderSummary(draft);
    renderReviewRows(draft);
  }

  async function checkKey() {
    if (!key) return false;
    keyInfo = null;
    render();
    const body = await openRouterJson("/api/v1/key", key);
    keyInfo = body.data;
    const problem = cappedKeyStatus(keyInfo);
    pricing = null;
    if (!problem) {
      try {
        const model = await openRouterJson(`/api/v1/model/${MODEL}`, key);
        pricing = parsePricing(model.data?.pricing);
      } catch { /* The split can still run if pricing is temporarily unavailable. */ }
    }
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

  async function classify(ids, description, draft, revision, phase) {
    const records = recordsFor(ids);
    const results = [];
    let inputTokens = 0;
    let usageComplete = true;
    for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
      if (revision !== runRevision || draft !== getDraft()) return null;
      const batch = records.slice(offset, offset + BATCH_SIZE);
      const body = await openRouterJson("/api/alpha/decisions", key, { method: "POST",
        body: JSON.stringify(requestFor(batch, description)) });
      const reportedTokens = Number(body.usage?.input_tokens ?? body.usage?.inputTokens);
      if (Number.isFinite(reportedTokens) && reportedTokens >= 0) inputTokens += reportedTokens;
      else usageComplete = false;
      for (const [index, record] of batch.entries()) {
        const answer = body.answers?.[`v${index}`];
        if (answer?.type !== "choice" || !["new", "leftover"].includes(answer.choice)) {
          throw new Error("Jev returned an incomplete classification. No suggestions were applied.");
        }
        const probability = Number(answer.probabilities?.[answer.choice] ?? answer.confidence ?? 0);
        results.push({ id: record.id, label: record.label, side: answer.choice,
          confidence: Number.isFinite(probability) ? Math.max(0, Math.min(1, probability)) : 0 });
      }
      message = `${phase}: classified ${Math.min(offset + BATCH_SIZE, records.length)} of ${records.length} variables…`;
      const statusText = els.definitionAiStatus.querySelector("span");
      if (statusText) statusText.textContent = message;
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
      if (!await checkKey() || revision !== runRevision || draft !== getDraft()) return;
      const outcome = await classify(ensureSample(draft), description, draft, revision, "Test run");
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
      message = `Could not test the split: ${error.message}`;
    } finally {
      busy = false;
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
    message = "Checking the key limit…";
    render();
    try {
      if (!await checkKey() || revision !== runRevision || draft !== getDraft()) return;
      const sampled = new Set(sampleIds);
      const remaining = draft.eligible_variable_ids.filter(id => !sampled.has(id));
      const outcome = await classify(remaining, description, draft, revision, "Full run");
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
      message = `Could not run the full split: ${error.message}`;
    } finally {
      busy = false;
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
      clearPreview();
    });
    els.definitionAiRun.addEventListener("click", () => void runTest());
    els.definitionAiFullRun.addEventListener("click", () => void runFull());
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

  return { install, render, clearPreview, takeResumeDraft };
}
