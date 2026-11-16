import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSpend, retryPolicy, estimateRequestCost, spendLabel } from '../site/paper_spend.mjs';
import { PaperModel, object, string } from '../site/paper_model.mjs';
const pricing={prompt:'0.0000001',completion:'0.000001'};
const keyData={data:{limit:5,limit_remaining:5,limit_reset:null}};
test('retry threshold counts all steps, persists, and permits exactly ten cents',()=>{
 const run={calls:[{id:'extraction',cost:.03},{id:'valid-step',cost:.07}]};
 assert.equal(reviewSpend(run).total,.1);assert.equal(retryPolicy(run).allowed,true);
 run.calls.push({id:'bad-reply',cost:.000001});
 assert.equal(retryPolicy(structuredClone(run)).reason,'spend');
 assert.match(spendLabel(run),/spent/);
});
test('lost requests are reserved once and never presented as confirmed spend',()=>{
 const run={calls:[{id:'valid',cost:.03}],autoRetries:[{id:'lost',estimatedCost:.04}],pending:{id:'lost',estimatedCost:.04}};
 assert.deepEqual(reviewSpend(run),{reported:.03,estimated:.04,total:.07,unknown:0});
 assert.equal(retryPolicy(run).allowed,true);
 run.calls.push({id:'lost',cost:.02});
 assert.deepEqual(reviewSpend(run),{reported:.05,estimated:0,total:.05,unknown:0});
 assert.equal(retryPolicy({calls:[{id:'unpriced',cost:null}]}).reason,'unknown');
 assert.equal(estimateRequestCost(null,{}),null);
 assert.ok(estimateRequestCost(pricing,{messages:[],max_tokens:12000}) >= .012);
});
test('cheap invalid responses keep correcting beyond two retries, without replaying accepted work',async()=>{
 const run={model:'fixture',capture:{},calls:[{id:'earlier-success',cost:.02}]};
 let requests=0;
 const request=async path=>path==='/api/v1/key'?keyData:(requests++,{usage:{cost:.01},choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({value:requests===5?'good':'bad'})}}]});
 const model=new PaperModel({run,getKey:()=> 'key',save:async()=>{},request});
 const options={validateResult:v=>{if(v.value!=='good')throw new Error('Bad quotation');}};
 await model.structured('qualification','Task',{},object({value:string}),options);
 assert.equal(requests,5);assert.equal(run.autoRetries.length,4);assert.equal(reviewSpend(run).total,.07);
 const restored=new PaperModel({run:structuredClone(run),getKey:()=> 'key',save:async()=>{},request});
 await restored.structured('qualification','Task',{},object({value:string}),options);
 assert.equal(requests,5);
});
test('network failures retry below the allowance, retaining estimated costs and respecting cancellation',async()=>{
 const run={model:'fixture',capture:{},modelPricing:pricing};let requests=0;
 const model=new PaperModel({run,getKey:()=> 'key',save:async()=>{},request:async path=>{
  if(path==='/api/v1/key')return keyData;
  requests++;if(requests===1)throw new Error('lost');
  return {usage:{cost:.002},choices:[{finish_reason:'stop',message:{role:'assistant',content:'done'}}]};
 }});
 await model.call('step',{messages:[]});
 assert.equal(requests,2);assert.equal(run.autoRetries[0].kind,'uncertain');
 assert.equal(reviewSpend(run).reported,.002);assert.ok(reviewSpend(run).estimated >= .012);
 const controller=new AbortController();controller.abort();
 const cancelled=new PaperModel({run,getKey:()=> 'key',save:async()=>{},request:async()=>{throw new Error('must not send');},signal:controller.signal});
 await assert.rejects(()=>cancelled.call('step',{messages:[]}));assert.equal(requests,2);
});
test('unknown outcomes stop once estimates exceed ten cents and do not reset on reopen',async()=>{
 const run={model:'fixture',capture:{},calls:[{id:'success',cost:.095}],modelPricing:pricing};let requests=0;
 const request=async path=>{if(path==='/api/v1/key')return keyData;requests++;throw new Error('lost');};
 const model=new PaperModel({run,getKey:()=> 'key',save:async()=>{},request});
 await assert.rejects(()=>model.call('step',{messages:[]}),/may have been billed/);
 assert.equal(requests,1);assert.equal(retryPolicy(run).reason,'spend');
 const restored=new PaperModel({run:structuredClone(run),getKey:()=> 'key',save:async()=>{},request});
 await assert.rejects(()=>restored.call('step',{messages:[]}),/confirmation/);assert.equal(requests,1);
});
test('cancelling during automatic retry backoff prevents another paid request',async()=>{
 const controller=new AbortController(),run={model:'fixture',capture:{},modelPricing:pricing};let requests=0;
 const model=new PaperModel({run,getKey:()=> 'key',save:async()=>{},signal:controller.signal,
  onProgress:event=>{if(typeof event==='object')controller.abort();},
  request:async path=>{if(path==='/api/v1/key')return keyData;requests++;throw new Error('lost');}});
 await assert.rejects(()=>model.call('step',{messages:[]}));
 assert.equal(requests,1);assert.equal(run.autoRetries.length,1);assert.ok(reviewSpend(run).estimated>0);
});
