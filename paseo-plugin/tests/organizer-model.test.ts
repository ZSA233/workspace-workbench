import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { modelProfileSchema, organizerPolicySchema } from '../shared/organizer.ts';
import { callOrganizerModel, organizerInput, mergeOrganizerItems } from '../server/organizer/model.ts';
import { conversationBatch } from '../server/organizer/conversation.ts';

test('local model sees bounded evidence, credentials stay in headers, invented citations are rejected and calls audited',async()=>{
  let invent=false,seen:any;const server=createServer(async(req,res)=>{if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}const parts=[];for await(const p of req)parts.push(p);seen={headers:req.headers,body:JSON.parse(Buffer.concat(parts).toString())};res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({title:'登录异常修复',brief:'修复登录异常',items:[{text:'修复登录',evidenceIds:[invent?'fake':'commit:one']}]})}}]}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
  const profile=modelProfileSchema.parse({id:'local',name:'Local',baseUrl:`http://127.0.0.1:${port}`,model:'fixture'}),policy=organizerPolicySchema.parse({});const runs:any[]=[];
  try {
    const result=await callOrganizerModel(profile,'secret',policy,[{id:'commit:one',kind:'commit',text:'Fix login'}],undefined,'workspace','ws',new AbortController().signal,r=>runs.push(r));
    assert.equal(result.value.title,'登录异常修复');assert.equal(seen.headers.authorization,'Bearer secret');assert.ok(!JSON.stringify(seen.body).includes('secret'));assert.ok(!JSON.stringify(runs).includes('secret'));
    assert.equal(runs[0].input.includes('Fix login'),true);invent=true;
    await assert.rejects(callOrganizerModel(profile,'secret',policy,[{id:'commit:one',kind:'commit',text:'Fix login'}],undefined,'workspace','ws',new AbortController().signal,r=>runs.push(r)),/evidence_invalid/);
    assert.match(runs[1].error,/evidence_invalid/);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('incremental checklist keeps manual edits and uses evidence identity to avoid paraphrase duplicates',()=>{
  const previous=[{id:'manual',text:'人工说明',state:'done' as const,evidenceIds:['one'],manual:true},{id:'auto',text:'旧说法',state:'todo' as const,evidenceIds:['two']}];
  const next=mergeOrganizerItems(previous,{title:'test',brief:'',items:[{id:'manual',text:'被覆盖',evidenceIds:['one'],completed:false},{text:'相同工作的另一种说法',evidenceIds:['two']}]},'ws');
  assert.equal(next.length,2);assert.equal(next[0].text,'人工说明');assert.equal(next[0].state,'done');assert.equal(next[1].id,'auto');
});
test('long public messages retain offsets and budget truncation is explicit and contiguous',()=>{
  const page={epoch:'e',hasOlder:false,hasNewer:false,entries:[{seqStart:1,seqEnd:2,item:{type:'user_message',text:'任'.repeat(6000)}},{seqStart:3,seqEnd:3,item:{type:'tool_call',text:'private tool output'}}]};
  const batch=conversationBatch('agent',page);assert.equal(batch.evidence.length,4);assert.ok(batch.evidence.every(e=>!e.text.includes('private')));
  const profile=modelProfileSchema.parse({id:'m',name:'m',baseUrl:'http://localhost',model:'m',contextTokens:8192,outputTokens:512});
  const input=organizerInput(batch.evidence,undefined,profile);assert.equal(input.truncated,true);assert.ok(input.evidence.length>0);
  const checkpoint=batch.checkpoints.get(input.evidence.at(-1)!.id)!;assert.ok(checkpoint.pendingMessage);assert.equal(checkpoint.cursor.seq,0);
  const resumed=conversationBatch('agent',page,{agentId:'agent',brief:'',items:[],complete:false,updatedAt:'',evidence:[],...checkpoint});assert.ok(!resumed.evidence[0].id.endsWith(':0'));
});

test('Sushi unloaded models are rejected without issuing a generation or switching models',async()=>{
  let posts=0;const server=createServer(async(req,res)=>{if(req.method==='POST')posts++;res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture',owned_by:'sushi',loaded:false,state:'unloaded'}]}));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{const profile=modelProfileSchema.parse({id:'s',name:'s',baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`,model:'fixture'});const runs:any[]=[];
    await assert.rejects(callOrganizerModel(profile,'',organizerPolicySchema.parse({}),[{id:'goal:1',kind:'goal',text:'修复登录'}],undefined,'workspace','one',new AbortController().signal,r=>runs.push(r)),/sushi_model_not_loaded/);assert.equal(posts,0);assert.match(runs[0].error,/not_loaded/);
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
test('manual checklist records survive automatic retention and separate tasks sharing evidence remain separate',()=>{
  const manual=Array.from({length:120},(_,i)=>({id:'m'+i,text:'人工事项'+i,state:'done' as const,evidenceIds:['source'],manual:true}));
  const result=mergeOrganizerItems(manual,{title:'test',brief:'',items:[]},'one');assert.equal(result.length,120);
  const two=mergeOrganizerItems([{id:'a',text:'旧说明',state:'todo',evidenceIds:['message:1']}],{title:'test',brief:'',items:[{id:'a',text:'说明更新',evidenceIds:['message:1']},{text:'另一件事',evidenceIds:['message:1']}]},'one');assert.equal(two.length,2);assert.notEqual(two[0].id,two[1].id);
});
