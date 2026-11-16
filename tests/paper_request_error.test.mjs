import test from 'node:test';
import assert from 'node:assert/strict';
import {openRouterJson} from '../site/definition_jev_core.mjs';
import {requestFailure,failureExplanation} from '../site/paper_request_error.mjs';
import {PaperModel} from '../site/paper_model.mjs';
import {recoveryState} from '../site/paper_review_state.mjs';
const reply=(status,body,headers={})=>new Response(JSON.stringify(body),{status,headers});
test('provider status, detail, request id and retryability survive an HTTP rejection',async()=>{
 let error;
 try{await openRouterJson('/api/v1/chat/completions','secret',{timeoutMs:500},async()=>reply(400,{error:{message:'Provider rejected request',code:400,metadata:{provider_name:'Example',raw:JSON.stringify({error:{message:'Unsupported parameter reasoning'}})}}},{'x-request-id':'req-123'}));}catch(e){error=e;}
 const detail=requestFailure(error,{key:'secret',step:'Assessing age',model:'pipeline-model'});
 assert.equal(detail.status,400);assert.equal(detail.retryable,false);assert.equal(detail.requestId,'req-123');
 assert.match(failureExplanation(detail),/Unsupported parameter reasoning/);
 const run={selectedClaim:{id:'claim'},pending:{id:'failed',phase:'Assessing age',requestError:detail}};
 const state=recoveryState(run,{connected:true});
 assert.match(state.message,/error 400/);assert.match(state.message,/Unsupported parameter/);
 assert.equal(state.step,'Assessing age');assert.equal(state.action,'Download error details');
});
test('rate limits and temporary in-flight credit limits honor Retry-After metadata',async()=>{
 for(const status of [429,402]){
  await assert.rejects(()=>openRouterJson('/test','key',{},async()=>reply(status,{error:{code:status,message:'Wait',metadata:{limit_source:'openrouter_in_flight_budget'}}},{'retry-after':'4'})),e=>e.retryable===true&&e.retryAfterMs===4000);
 }
 await assert.rejects(()=>openRouterJson('/test','key',{},async()=>reply(402,{error:{code:402,message:'Insufficient credits'}})),e=>e.retryable===false);
});
test('HTTP 200 error envelopes are not accepted as successful model responses',async()=>{
 await assert.rejects(()=>openRouterJson('/test','key',{},async()=>reply(200,{error:{code:503,message:'Provider unavailable'}})),e=>e.status===200&&e.providerCode===503&&e.retryable===true);
});
test('timeouts retain their duration without forwarding timeoutMs to fetch',async()=>{
 await assert.rejects(()=>openRouterJson('/test','key',{timeoutMs:5},async(url,options)=>{
  assert.equal(options.timeoutMs,undefined);
  return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
 }),e=>e.kind==='timeout'&&e.timeoutMs===5&&e.retryable===true);
});
test('diagnostics redact keys and retain only the provider error message',()=>{
 const safe=requestFailure({message:'Failed secret-key',providerDetail:JSON.stringify({error:{message:'Rejected Bearer secret-key'},headers:{Authorization:'secret-key'}})},{key:'secret-key'});
 assert.equal(JSON.stringify(safe).includes('secret-key'),false);
 assert.equal(JSON.stringify(safe).includes('Authorization'),false);
});
test('nonretryable HTTP errors stop immediately, even below the spending allowance',async()=>{
 const run={model:'fixture',capture:{},modelPricing:{prompt:'0.0000001',completion:'0.0000001'}};let paid=0;
 const model=new PaperModel({run,getKey:()=> 'secret-key',save:async()=>{},request:async(path,key,options)=>{
  if(path==='/api/v1/key')return {data:{limit:5,limit_remaining:5,limit_reset:null}};
  assert.equal(options.timeoutMs,180000);paid++;
  throw Object.assign(new Error('Insufficient credits'),{kind:'http',status:402,retryable:false});
 }});
 await assert.rejects(()=>model.call('Assessing age',{messages:[]}),/Insufficient credits/);
 assert.equal(paid,1);assert.equal(run.pending.requestError.status,402);assert.equal(run.autoRetries,undefined);
 assert.match(run.pending.error,/402/);assert.equal(JSON.stringify(run).includes('secret-key'),false);
});
test('reconnection is the next action for a rejected key and old failures are explicitly unidentified',()=>{
 const rejected={selectedClaim:{},pending:{phase:'Setup',requestError:{kind:'http',status:401,message:'Invalid key',retryable:false}}};
 assert.equal(recoveryState(rejected,{connected:true}).action,'Reconnect OpenRouter');
 assert.match(recoveryState({pending:{phase:'Assessing age'}},{connected:true}).message,/exact cause is unavailable/);
});
test('an HTML access-denied response retains its HTTP status and is not repeatedly retried',async()=>{
 await assert.rejects(()=>openRouterJson('/test','key',{},async()=>new Response('<html>Access denied</html>',{status:403,headers:{'cf-ray':'ray-123'}})),e=>e.kind==='http'&&e.status===403&&e.retryable===false&&e.requestId==='ray-123');
});
