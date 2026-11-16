import test from 'node:test';
import assert from 'node:assert/strict';
import { recordProgress, progressSnapshot, elapsedLabel } from '../site/paper_progress.mjs';
const start = Date.parse('2026-11-16T10:00:00Z');
test('work counters advance only for actual accepted decisions, not elapsed time', () => {
 const run={queue:{confounderIds:['a','b'],links:[{findings:[{raw_link_id:'one'},{raw_link_id:'two'}]}]},review:{confounders:{a:{}},findings:{one:{}}}};
 recordProgress(run,'assess','Assessing confounders','Checking B',start);
 const a=progressSnapshot(run,{busy:true,now:start+5000,startedAt:start});
 const b=progressSnapshot(run,{busy:true,now:start+45000,startedAt:start});
 assert.equal(a.assessed,1);assert.equal(b.assessed,1);assert.equal(b.decisions,1);
 assert.equal(b.total,2);assert.equal(b.determinate,true);assert.match(b.waiting,/no new update for 45s/);
 run.review.confounders.b={};assert.equal(progressSnapshot(run).assessed,2);
 recordProgress(run,'findings','Checking studies','Checking B',start+46000);
 assert.equal(progressSnapshot(run).determinate,false); // Available findings are not a required total.
});
test('pending AI calls show a real wait duration and uncertain calls are paused, not complete', () => {
 const run={pending:{startedAt:new Date(start).toISOString()},calls:[]};
 recordProgress(run,'qualify','Checking the claim','Reading full text',start);
 const working=progressSnapshot(run,{busy:true,now:start+32000,startedAt:start});
 assert.match(working.waiting,/Waiting for the AI response · 32s/);assert.equal(working.elapsedSeconds,32);
 const paused=progressSnapshot(run,{busy:false,now:start+65000,needsResume:true});
 const stale=progressSnapshot(run,{busy:true,now:start+120000,startedAt:start+110000});
 assert.equal(stale.state,'paused');assert.equal(stale.waiting,'');
 assert.equal(paused.state,'paused');assert.equal(paused.waiting,'');assert.equal(paused.completedCalls,0);
 run.outcome={};assert.equal(progressSnapshot(run).state,'complete');
 assert.equal(elapsedLabel(125),'2m 5s');
});
test('stage history is bounded and records new activity without fabricating completed stages', () => {
 const run={};
 for(let i=0;i<20;i++) recordProgress(run,'setup','Matching variables',`Step ${i}`,start+i*1000);
 assert.equal(run.progress.history.length,12);
 assert.equal(Date.parse(run.progress.stageStartedAt),start);
 recordProgress(run,'map','Finding confounders','Building graph',start+21000);
 assert.equal(Date.parse(run.progress.stageStartedAt),start+21000);
 assert.equal(progressSnapshot(run).stage,'map');
});
