import { retryPolicy } from './paper_spend.mjs';
export function recoveryState(run, { connected = false, error = '' } = {}) {
  if (!run || run.outcome || run.qualification?.eligible === false) return null;
  const pending = run.pending;
  const policy = retryPolicy(run);
  const needsCostApproval = pending && !policy.allowed && policy.reason !== "unavailable";
  const received = pending && (pending.kind === 'invalid_response' || /invalid structured response/i.test(pending.phase || '')
    || run.phase === 'invalid_response' || run.calls?.some(call => call.id === pending.id));
  const rawReason = error || run.failure?.message || pending?.error || '';
  if (!pending && !rawReason && !run.selectedClaim && run.pipelineExtraction) return null;
  return {
    title: needsCostApproval ? 'Review paused — your choice' : 'Review paused',
    message: pending ? received ? 'The last AI response could not be used. The review has not finished.' : 'The last AI request was interrupted. ECHO cannot confirm whether it finished or was charged.'
      : 'The review stopped before it finished. Completed work is saved.',
    reason: needsCostApproval && policy.reason === 'spend' ? 'Automatic retries stopped because this review has used more than its $0.10 allowance, including any estimated charges.'
      : needsCostApproval ? 'Automatic retries stopped because the cost of a request is unavailable.' : '',
    cost: pending ? 'Retry sends a new paid AI request for the unfinished step. Completed steps will not be repeated.' : 'Resume continues from the saved step. Further AI requests use your connected OpenRouter key.',
    action: connected ? pending ? 'Retry unfinished step' : 'Resume review' : 'Connect OpenRouter to resume',
    kind: received ? 'invalid_response' : pending ? 'uncertain' : 'stopped'
  };
}
// Called after an explicit continue/retry click. Cost approval is shown only
// after the automatic allowance is spent or costs cannot be established. Durable receipts for accepted work remain untouched.
export function acknowledgeRetry(run, now = new Date().toISOString()) {
  if (!run.pending) return;
  run.uncertainCalls ||= [];
  const receipt = run.pending.requestHash ? run.receipts?.[run.pending.requestHash] : null;
  run.uncertainCalls.push({ ...run.pending, ...(receipt ? { receivedResponse: receipt } : {}), retryAcknowledgedAt: now });
  if (run.pending.requestHash) delete run.receipts?.[run.pending.requestHash];
  run.pending = null; run.failure = null; run.phase = 'retry_acknowledged';
}
