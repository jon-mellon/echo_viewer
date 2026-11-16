export const AUTO_RETRY_USD = 0.10;
const micros = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 1e6) : null;
export function reviewSpend(run) {
  let reported = 0, estimated = 0, unknown = 0;
  const seen = new Set();
  for (const row of [...(run?.calls || []), ...(run?.autoRetries || []), ...(run?.uncertainCalls || []), ...(run?.pending ? [run.pending] : [])]) {
    if (row.id && seen.has(row.id)) continue;
    if (row.id) seen.add(row.id);
    const actual = micros(row.cost), estimate = micros(row.estimatedCost);
    if (actual !== null) reported += actual;
    else if (estimate !== null) estimated += estimate;
    else unknown++;
  }
  return { reported: reported / 1e6, estimated: estimated / 1e6, total: (reported + estimated) / 1e6, unknown };
}
export function spendLabel(run) {
  const spend = reviewSpend(run);
  return `$${spend.reported.toFixed(4)} spent${spend.estimated ? ` + $${spend.estimated.toFixed(4)} estimated` : ''}${spend.unknown ? ' + unconfirmed charges' : ''}`;
}
export function retryPolicy(run) {
  const spend = reviewSpend(run);
  if (spend.unknown) return { allowed: false, reason: 'unknown', spend };
  if (Math.round(spend.total * 1e6) > Math.round(AUTO_RETRY_USD * 1e6)) return { allowed: false, reason: 'spend', spend };
  // Stop pathological free/near-free loops without claiming a spending limit was reached.
  if ((run.autoRetries?.length || 0) >= 100) return { allowed: false, reason: 'unavailable', spend };
  return { allowed: true, spend };
}
export function recordAutomaticRetry(run, failed) {
  run.autoRetries ||= [];
  run.autoRetries.push({ ...failed, automaticallyRetriedAt: new Date().toISOString() });
  run.pending = null;
}
// Reserve a deliberately generous input allowance and the full output limit
// for lost responses. Estimates remain visibly separate from reported charges.
export function estimateRequestCost(pricing, payload, usage) {
  const price = field => pricing?.[field] !== undefined && Number.isFinite(Number(pricing[field])) && Number(pricing[field]) >= 0 ? Number(pricing[field]) : null;
  const input = price('prompt'), output = price('completion');
  if (input === null || output === null) return null;
  const inputTokens = usage?.prompt_tokens ?? new TextEncoder().encode(JSON.stringify(payload)).length + 1024;
  const outputTokens = usage?.completion_tokens ?? payload.max_tokens ?? 12000;
  return Math.ceil((inputTokens * input + outputTokens * output + (price('request') || 0)) * 1e6) / 1e6;
}
