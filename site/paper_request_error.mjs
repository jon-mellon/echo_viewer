// Persist only safe, bounded diagnostic fields, never request bodies or headers.
export function requestFailure(error, { key, step, model, cancelled = false } = {}) {
  const clean = value => typeof value === 'string' ? value.replaceAll(key || '\u0000', '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 1200) : value;
  let detail = error?.providerDetail;
  if (typeof detail === 'string') { try { detail = JSON.parse(detail); } catch { /* Plain provider error text. */ } }
  if (detail && typeof detail === 'object') detail = detail.error?.message || detail.message || detail.detail || '';
  const status = Number(error?.providerCode) || Number(error?.status) || null;
  const kind = cancelled ? 'cancelled' : error?.kind || 'network';
  const retryable = !cancelled && (typeof error?.retryable === 'boolean' ? error.retryable : !status || [408,425,429].includes(status) || status >= 500);
  return { kind, message: clean(error?.message || String(error)), step: clean(step), model: clean(model),
    status: Number(error?.status) || null, providerCode: ["string", "number"].includes(typeof error?.providerCode) ? clean(error.providerCode) : null,
    provider: clean(error?.provider || null), providerDetail: clean(typeof detail === "string" ? detail : ""), limitSource: clean(typeof error?.limitSource === "string" ? error.limitSource : ""), requestId: clean(error?.requestId || null),
    timeoutMs: Number(error?.timeoutMs) || null, retryAfterMs: Math.min(30000, Math.max(0, Number(error?.retryAfterMs) || 0)), retryable };
}
export function failureExplanation(failure) {
  if (!failure) return 'This saved attempt used an older version that did not record the underlying request error. Its exact cause is unavailable.';
  const code = Number(failure.providerCode) || failure.status;
  if (failure.kind === 'cancelled') return 'The request stopped when the review was cancelled.';
  if (failure.kind === 'timeout') return `OpenRouter did not return a complete response within ${Math.round(failure.timeoutMs / 1000)} seconds.`;
  if (failure.kind === 'http') return `OpenRouter ${failure.provider ? `(${failure.provider}) ` : ''}returned ${code ? `error ${code}: ` : 'an error: '}${failure.message}${failure.providerDetail && failure.providerDetail !== failure.message ? ` — ${failure.providerDetail}` : ''}`;
  if (['validation','incomplete'].includes(failure.kind)) return failure.message;
  if (failure.kind === 'invalid_json') return failure.message;
  return `The browser could not complete the OpenRouter connection: ${failure.message}. No HTTP response was available; this can result from a connection or browser-blocking problem.`;
}
