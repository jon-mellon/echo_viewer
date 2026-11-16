import test from 'node:test';
import assert from 'node:assert/strict';
import { PAPER_PIPELINE } from '../site/paper_pipeline_contract.mjs';
import { extractPipelineClaims, pipelineClaims } from '../site/paper_pipeline.mjs';
import { PaperModel } from '../site/paper_model.mjs';
import { createKeyStore } from '../extension/key_store.mjs';

const graph = () => ({s:'success',v:[{vi:'v1',a:['person'],c:"uoa's exposure"},{vi:'v2',a:['person'],c:"uoa's outcome"}],l:[{li:'l1',s:['v1'],t:'v2',e:'present',p:'adults',d:'implied_selection_on_observables'}]});
test('extraction uses the exact vendored harvest v4 prompt, schema, human template and Luna settings', async () => {
  let args;
  const run = {capture:{title:'<i>Study</i>',abstract:'Original abstract'}};
  const claims = await extractPipelineClaims({run, structured:async (...value) => {args=value;return graph();}});
  assert.equal(PAPER_PIPELINE.model,'openai/gpt-6-luna');
  assert.equal(args[3],PAPER_PIPELINE.extractionSchema);
  assert.equal(args[4].messages[1].content,PAPER_PIPELINE.extractionPrompt);
  assert.equal(args[4].messages[2].content,'# Title\n\nStudy\n\n# Abstract\n\nOriginal abstract');
  assert.deepEqual(args[4].reasoning,{effort:'low'});
  assert.equal(args[4].max_tokens,8192);
  assert.equal(claims[0].eligible,true);
  assert.equal(claims[0].id,'l1');
  assert.deepEqual(run.pipelineExtraction,graph());
  assert.match(run.pipeline.sourceHashes['classify/src/harvest/classify/prompt.py'],/^[a-f0-9]{64}$/);
});
test('pipeline graph validation preserves references, uniqueness, null populations and eligibility', () => {
  const g=graph();g.l[0].p=null;assert.equal(pipelineClaims(g).length,1);
  g.l[0].t='v3';assert.throws(()=>pipelineClaims(g),/unknown variables/);
  g.l[0].t='v2';g.v.push(g.v[0]);assert.throws(()=>pipelineClaims(g),/Duplicate/);
  const malformed=graph();malformed.v[0].c='invented';assert.throws(()=>pipelineClaims(malformed),/invalid string/);
  const randomized=graph();randomized.l[0].d='randomized_experiment';assert.equal(pipelineClaims(randomized)[0].eligible,false);
  const nonperson=graph();nonperson.v[0].a=['country'];assert.equal(pipelineClaims(nonperson)[0].eligible,false);
  assert.deepEqual(pipelineClaims({s:'no_variables_found',v:[],l:[]}),[]);
  assert.throws(()=>pipelineClaims({...graph(),s:'no_variables_found'}),/empty graph/);
});
test('pipeline split classification uses Luna with reasoning off and maps actual classifications to existing tools', async () => {
  const run={model:PAPER_PIPELINE.model,pipeline:{},capture:{},calls:[]}; let sent;
  const client=new PaperModel({run,getKey:()=> 'capped-key',save:async()=>{},request:async(path,key,options)=> {
    if(path==='/api/v1/key') return {data:{limit:5,limit_remaining:4,limit_reset:null}};
    assert.equal(path,'/api/v1/chat/completions'); sent=JSON.parse(options.body);
    return {choices:[{finish_reason:'stop',message:{content:'{"new_ids":[1]}'}}]};
  }});
  const result=await client.jevRequest('/api/alpha/decisions','capped-key',{method:'POST',body:JSON.stringify({state:{target_definition:'Target',records:[{label:'Other'},{label:'Target'}]}})});
  assert.equal(sent.model,PAPER_PIPELINE.model);
  assert.deepEqual(sent.reasoning,{effort:'none'});
  assert.equal(sent.messages[0].content,PAPER_PIPELINE.classificationPrompt);
  assert.equal(result.answers.v0.choice,'leftover');assert.equal(result.answers.v1.choice,'new');
  assert.equal(run.calls[0].model,PAPER_PIPELINE.model);
});
function storageFixture() {
  const levels=[];const data={session:{},local:{}};
  const storage=Object.fromEntries(Object.keys(data).map(name=>[name,{
    setAccessLevel:async level=>levels.push([name,level.accessLevel]),
    get:async key=>({[key]:data[name][key]}),set:async value=>Object.assign(data[name],value),remove:async key=>{delete data[name][key];}
  }]));return {storage,data,levels};
}
test('key vault restricts access before reads, defaults to session only, supports opt-in persistence and forget', async () => {
  const {storage,data,levels}=storageFixture();const vault=createKeyStore(storage);
  await vault.save('limited-key');
  assert.deepEqual(levels,[['session','TRUSTED_CONTEXTS'],['local','TRUSTED_CONTEXTS']]);
  assert.deepEqual(data.local,{});assert.deepEqual(await vault.read(),{key:'limited-key',persistent:false});
  await vault.save('limited-key',true);
  data.session={};assert.deepEqual(await createKeyStore(storage).read(),{key:'limited-key',persistent:true});
  await vault.save('limited-key',false);assert.deepEqual(data.local,{});
  await vault.forget();assert.deepEqual(await vault.read(),{key:null,persistent:false});
});
test('key vault fails closed if trusted-context isolation cannot be established', async () => {
  const {storage}=storageFixture();let read=false;
  storage.local.setAccessLevel=async()=>{throw new Error('unsupported');};
  storage.local.get=async()=>{read=true;return {};};
  await assert.rejects(createKeyStore(storage).read(),/unsupported/);assert.equal(read,false);
});
test('an invalid pipeline graph is marked for explicit retry rather than silently replayed or accepted', async () => {
  const run={model:PAPER_PIPELINE.model,pipeline:{},capture:{title:'Study',abstract:'Abstract'}};
  let requests=0;
  const invalid=graph();invalid.l[0].t='v99';
  const model=new PaperModel({run,getKey:()=> 'key',save:async()=>{},request:async(path)=> {
    if(path==='/api/v1/key') return {data:{limit:5,limit_remaining:4,limit_reset:null}};
    requests++;return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(invalid)}}]};
  }});
  await assert.rejects(extractPipelineClaims(model),/unknown variables/);
  assert.ok(run.pending);assert.equal(run.pipelineExtraction,undefined);
  await assert.rejects(extractPipelineClaims(model),/uncertain/);assert.equal(requests,1);
});
