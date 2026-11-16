import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryState, acknowledgeRetry } from '../site/paper_review_state.mjs';
test('known unusable replies offer one retry with an accurate charge explanation', () => {
 const run={pending:{id:'bad',phase:'Invalid structured response',requestHash:'bad-hash'},calls:[{id:'bad'}]};
 const state=recoveryState(run,{connected:true,error:'The AI returned an unverified classification. No result was accepted. Acknowledge retry.'});
 assert.equal(state.action,'Retry review');assert.equal(state.kind,'invalid_response');
 assert.match(state.message,/returned a response/);assert.match(state.cost,/new AI request/);
 assert.doesNotMatch(state.cost,/already/);assert.doesNotMatch(state.reason,/Acknowledge/);
 assert.ok(run.pending); // Rendering a choice never authorizes a retry.
});
test('unknown request outcomes warn about a possible repeat charge and reconnect is distinct', () => {
 const run={pending:{id:'lost',phase:'Checking claim',requestHash:'lost-hash'}};
 assert.match(recoveryState(run,{connected:true}).cost,/may already have been charged/);
 assert.equal(recoveryState(run).action,'Reconnect to continue');
});
test('explicit retry clears only failed work and preserves its received reply and accepted receipts', () => {
 const reply={id:'bad',message:{content:'invalid'}};
 const run={pending:{id:'bad',requestHash:'bad-hash'},receipts:{'bad-hash':reply,good:{id:'accepted'}},failure:{message:'failed'}};
 acknowledgeRetry(run,'2026-11-16T16:00:00Z');
 assert.equal(run.pending,null);assert.equal(run.failure,null);assert.equal(run.receipts['bad-hash'],undefined);
 assert.equal(run.receipts.good.id,'accepted');assert.equal(run.uncertainCalls[0].receivedResponse,reply);
 assert.equal(run.uncertainCalls[0].retryAcknowledgedAt,'2026-11-16T16:00:00Z');
});
test('retired catch-all diagnostics do not repeat misleading DiD claims in the main screen', () => {
 const run={selectedClaim:{id:'x'}};
 const state=recoveryState(run,{connected:true,error:'The protocol requires a person-level nonrandomized observational causal claim; difference-in-differences is unsupported. No result was accepted.'});
 assert.doesNotMatch(state.reason,/difference-in-differences/);assert.match(state.reason,/previous claim-check rule/);
 assert.equal(recoveryState({outcome:{}},{connected:true}),null);
 assert.equal(recoveryState({qualification:{eligible:false}},{connected:true}),null);
});

test('a captured review can continue extraction while extracted claims need only a choice', () => {
 assert.equal(recoveryState({phase:'confirmed'},{connected:true}).action,'Continue review');
 assert.equal(recoveryState({phase:'claims_extracted',pipelineExtraction:{}},{connected:true}),null);
});
