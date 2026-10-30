export const JEV_MODEL = "typesafe/jev-1.13";
export const JEV_BATCH_SIZE = 16;
export const JEV_TEST_SIZE = 50;
export const JEV_MAX_KEY_LIMIT_USD = 5;
const REQUEST_TIMEOUT_MS = 60_000;

export async function openRouterJson(path, key, options = {}, fetchImpl = fetch) {
  const { signal, ...fetchOptions } = options;
  const controller = new AbortController();
  const stop = () => controller.abort(signal.reason);
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`https://openrouter.ai${path}`, {
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
    if (controller.signal.reason === "timeout") throw new Error("OpenRouter did not respond within 60 seconds.");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

export function parseJevPricing(data) {
  const values = [data?.prompt, data?.completion, data?.request ?? 0].map(Number);
  if (values.some(value => !Number.isFinite(value) || value < 0)) return null;
  return { input: values[0], output: values[1], request: values[2] };
}

export function jevRequestSizes(records, description) {
  let inputTokens = 0;
  let requests = 0;
  for (let offset = 0; offset < records.length; offset += JEV_BATCH_SIZE) {
    inputTokens += Math.ceil(JSON.stringify(jevRequest(records.slice(offset, offset + JEV_BATCH_SIZE), description)).length / 4);
    requests += 1;
  }
  return { inputTokens, requests, records: records.length };
}

export function estimatedJevCharge(size, pricing, calibration = 1) {
  const outputTokens = size.records * 8;
  return (size.inputTokens * calibration * pricing.input) + (outputTokens * pricing.output)
    + (size.requests * pricing.request);
}

export function cappedKeyStatus(data) {
  if (!data || !Number.isFinite(data.limit) || data.limit < 0) {
    return "This key was rejected: Set a spending limit of $5 or less that never resets in OpenRouter key settings, then recheck the limit.";
  }
  if (data.limit > JEV_MAX_KEY_LIMIT_USD) {
    return `This key was rejected: It allows $${data.limit} of spending. Lower its limit to $5 or less in OpenRouter key settings, then recheck the limit.`;
  }
  if (data.limit_reset !== null) {
    return "This key was rejected: Choose a limit that never resets, rather than a daily, weekly, or monthly limit, then recheck the limit.";
  }
  if (!Number.isFinite(data.limit_remaining) || data.limit_remaining <= 0) {
    return "This key has no spending allowance left. Connect a new capped key.";
  }
  return null;
}

export function randomSampleIds(sourceIds, count = JEV_TEST_SIZE, cryptoApi = globalThis.crypto) {
  const ids = [...sourceIds];
  const random = new Uint32Array(ids.length);
  for (let offset = 0; offset < random.length; offset += 16_384) {
    cryptoApi.getRandomValues(random.subarray(offset, offset + 16_384));
  }
  for (let index = ids.length - 1; index > 0; index -= 1) {
    const swap = random[index] % (index + 1);
    [ids[index], ids[swap]] = [ids[swap], ids[index]];
  }
  return ids.slice(0, count);
}

export function jevRecords(ids, getVariable) {
  return ids.map(id => {
    const variable = getVariable(id) || {};
    return { id, label: String(variable.display_label || variable.concept_label || id).slice(0, 300),
      text: String(variable.raw_variable_text || variable.concept_label || "").slice(0, 600) };
  });
}

export function jevRequest(batch, description) {
  const questions = Object.fromEntries(batch.map((record, index) => [`v${index}`, {
    type: "choice", instructions: `Classify the source variable at records[${index}] using its label and text. Choose new only when it clearly fits target_definition. Leftover is the remainder of the selected source variables, not a separately defined opposite concept. Put uncertain or ambiguous matches in leftover for human review.`,
    criteria: { new: "Clearly belongs in the new variable described by target_definition",
      leftover: "Does not clearly belong in the new variable described by target_definition, including uncertain matches" },
  }]));
  return { model: JEV_MODEL,
    state: { target_definition: description, records: batch.map(({ label, text }) => ({ label, text })) },
    questions };
}

export function jevResults(body, batch) {
  return batch.map((record, index) => {
    const answer = body.answers?.[`v${index}`];
    if (answer?.type !== "choice" || !["new", "leftover"].includes(answer.choice)) {
      throw new Error("The model returned an incomplete classification. Completed batches remain saved.");
    }
    const probability = Number(answer.probabilities?.[answer.choice] ?? answer.confidence ?? 0);
    return { id: record.id, label: record.label, side: answer.choice,
      confidence: Number.isFinite(probability) ? Math.max(0, Math.min(1, probability)) : 0 };
  });
}
