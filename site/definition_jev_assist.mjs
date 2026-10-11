import { h, replaceChildren } from "./dom_builder.mjs";

const MODEL = "typesafe/jev-1.13";
const MAX_KEY_LIMIT_USD = 5;
const OAUTH_PENDING_KEY = "echo-openrouter-pkce-v1";
const OAUTH_DRAFT_KEY = "echo-openrouter-definition-draft-v1";
const BATCH_SIZE = 16;

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
  persistDraft }) {
  let key = null;
  let keyInfo = null;
  let settingsUrl = null;
  let preview = null;
  let previewDraft = null;
  let busy = false;
  let message = "Connect OpenRouter, then set a $5 lifetime cap on the key it creates.";
  let runRevision = 0;

  function clearPreview() {
    preview = null;
    previewDraft = null;
    runRevision += 1;
    render();
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
    els.definitionAiRun.disabled = !active || !key || Boolean(cappedKeyStatus(keyInfo))
      || busy || !String(draft.ai_description || "").trim();
    els.definitionAiRun.textContent = busy ? "Classifying variables…" : "Suggest split";
    replaceChildren(els.definitionAiStatus, h("span", { textContent: message }),
      settingsUrl ? h("a", { href: settingsUrl, target: "_blank", rel: "noopener noreferrer",
        textContent: "Open key settings" }) : null);
    const showPreview = active && previewDraft === draft && preview?.length;
    els.definitionAiPreview.hidden = !showPreview;
    if (!showPreview) return;
    const newCount = preview.filter(item => item.side === "new").length;
    const uncertain = preview.filter(item => item.confidence < 0.65).length;
    els.definitionAiSummary.textContent = `${newCount} suggested for new · ${preview.length - newCount} leftover · ${uncertain} uncertain. Review each side below; nothing changes until you apply.`;
    replaceChildren(els.definitionAiRows, [...preview].sort((a, b) => a.confidence - b.confidence)
      .map(item => h("div", { className: "definition-ai-row" },
        h("span", { textContent: `${item.label} · ${Math.round(item.confidence * 100)}% confidence` }),
        h("select", { dataset: { variableId: item.id }, attrs: { "aria-label": `Side for ${item.label}` } },
          h("option", { value: "new", textContent: "New variable", selected: item.side === "new" }),
          h("option", { value: "leftover", textContent: "Leftover", selected: item.side === "leftover" })))));
    els.definitionAiRows.querySelectorAll("select[data-variable-id]").forEach(select =>
      select.addEventListener("change", () => {
        const item = preview.find(entry => entry.id === select.dataset.variableId);
        if (item) item.side = select.value;
        els.definitionAiSummary.textContent = `${preview.filter(entry => entry.side === "new").length} suggested for new · ${preview.filter(entry => entry.side === "leftover").length} leftover. Review each side below; nothing changes until you apply.`;
      }));
  }

  async function checkKey() {
    if (!key) return false;
    keyInfo = null;
    render();
    const body = await openRouterJson("/api/v1/key", key);
    keyInfo = body.data;
    const problem = cappedKeyStatus(keyInfo);
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

  async function suggest() {
    const draft = getDraft();
    if (!draft || draft.step !== "partition" || !key || busy) return;
    const description = String(draft.ai_description || "").trim();
    if (!description) return;
    const revision = ++runRevision;
    busy = true;
    preview = null;
    previewDraft = null;
    message = "Checking the key limit…";
    render();
    try {
      if (!await checkKey()) return;
      const records = draft.eligible_variable_ids.map(id => {
        const variable = getVariable(id) || {};
        return { id, label: String(variable.display_label || variable.concept_label || id).slice(0, 300),
          text: String(variable.raw_variable_text || variable.concept_label || "").slice(0, 600) };
      });
      const results = [];
      for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
        if (revision !== runRevision || draft !== getDraft()) return;
        const batch = records.slice(offset, offset + BATCH_SIZE);
        const questions = Object.fromEntries(batch.map((record, index) => [`v${index}`, {
          type: "choice", instructions: `Classify the variable at records[${index}] against target_definition. Use its label and text.`,
          criteria: { new: "Belongs in the new variable described by target_definition",
            leftover: "Does not belong in the new variable described by target_definition" },
        }]));
        const body = await openRouterJson("/api/alpha/decisions", key, { method: "POST",
          body: JSON.stringify({ model: MODEL,
            state: { target_definition: description, records: batch.map(({ label, text }) => ({ label, text })) },
            questions }) });
        for (const [index, record] of batch.entries()) {
          const answer = body.answers?.[`v${index}`];
          if (answer?.type !== "choice" || !["new", "leftover"].includes(answer.choice)) {
            throw new Error("Jev returned an incomplete classification. No suggestions were applied.");
          }
          const probability = Number(answer.probabilities?.[answer.choice] ?? answer.confidence ?? 0);
          results.push({ id: record.id, label: record.label, side: answer.choice,
            confidence: Number.isFinite(probability) ? Math.max(0, Math.min(1, probability)) : 0 });
        }
        message = `Classified ${Math.min(offset + BATCH_SIZE, records.length)} of ${records.length} variables…`;
        render();
      }
      if (revision !== runRevision || draft !== getDraft()) return;
      preview = results;
      previewDraft = draft;
      message = "Suggestions ready. Review them before applying.";
    } catch (error) {
      message = `Could not suggest a split: ${error.message}`;
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
      clearPreview();
    });
    els.definitionAiConnect.addEventListener("click", () => void connect());
    els.definitionAiRecheck.addEventListener("click", () => {
      void checkKey().catch(error => {
        message = `Could not check this key: ${error.message}`;
        render();
      });
    });
    els.definitionAiDisconnect.addEventListener("click", () => {
      key = null; keyInfo = null;
      message = "Disconnected from OpenRouter in this tab. You can revoke the key in OpenRouter.";
      clearPreview();
    });
    els.definitionAiRun.addEventListener("click", () => void suggest());
    els.definitionAiApply.addEventListener("click", () => {
      if (!preview || previewDraft !== getDraft()) return;
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
