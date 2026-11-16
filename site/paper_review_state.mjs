import { retryPolicy, spendLabel } from './paper_spend.mjs';
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
    title: needsCostApproval ? 'Continue this review?' : !pending && !rawReason ? 'Continue your review' : 'Review stopped',
    message: needsCostApproval ? policy.reason === 'spend' ? 'This review has passed the $0.10 automatic-retry allowance. Your completed work is saved.' : 'ECHO cannot confirm the cost of the last request. Your completed work is saved.' : received ? 'The AI returned a response ECHO could not use. Your completed work is saved.'
      : pending ? 'ECHO did not receive a confirmed response to the last AI request. Your completed work is saved.'
        : rawReason ? 'The review stopped before it could finish. Your completed work is saved.' : 'Continue from where you stopped. Your completed work is saved.',
    reason: needsCostApproval ? '' : /The protocol requires a person-level nonrandomized observational causal/i.test(rawReason)
      ? 'A previous claim-check rule could not validate this response. Retry to check the claim with the current rules.'
      : rawReason.replace(/\s+No result was accepted\.[\s\S]*$/, '').replace(/\s+The response could not be used\.[\s\S]*$/, '').replace(/\s+Acknowledge retry[\s\S]*$/, '').slice(0, 350),
    cost: needsCostApproval ? `${spendLabel(run)} for this review. Another request may add a charge.` : '',
    action: connected ? pending && needsCostApproval ? 'Retry review' : 'Continue review' : 'Reconnect to continue',
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
