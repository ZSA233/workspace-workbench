import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionModelInput} from '../server/organizer/session-model.ts';
import {conversationBatch} from '../server/organizer/conversation.ts';
import {modelProfileSchema,organizerPolicySchema,type WorkspaceAnalysis,type OrganizerEvidence} from '../shared/organizer.ts';

const profile=modelProfileSchema.parse({id:'local',name:'local',baseUrl:'http://127.0.0.1',model:'fixture',contextTokens:16384,outputTokens:2048}),policy=organizerPolicySchema.parse({});
function workspace(id:string,commits=100,cached=false):WorkspaceAnalysis{
 const key=id+':9ff0e6a5-8c0a-419e-833e-7fce037a3215',evidence:OrganizerEvidence[]=[...Array.from({length:commits},(_,i)=>({id:`commit:repository-${i%5}:`+i.toString(16).padStart(40,'0'),kind:'commit' as const,text:'feat(relationship): 更新关系配额、退款风控与榜单边界 '+i})),...Array.from({length:6},(_,i)=>({id:'diff:repo-'+i+':'+key,kind:'diff' as const,text:'diff --git a/relationship.go b/relationship.go\n'+('+修复关系退款边界 "quoted" \\ 😀\n').repeat(350)})),{id:'hint:'+key,kind:'hint',text:id}];
 return{key,title:id,brief:'',items:[],material:{workspaceId:id,instance:key,name:id,createdAt:'2026-01-01',activityAt:'2026-01-01',fingerprint:'fp:'+id,evidence,repositories:[],taskBrief:'',state:'unknown',complete:false},...(cached?{digest:{version:1 as const,title:'公会统计读取优化',brief:'减少统计读取的扫描和往返。',evidenceIds:[evidence[0].id],fingerprint:'fp:'+id,at:'2026-01-01',partial:false}}:{})};
}
const history=()=>{const page={epoch:'982ad021-329b-479a-a61b-6b9ce99e8782',hasOlder:true,hasNewer:false,entries:[{seqStart:100,seqEnd:100,item:{type:'assistant_message',text:'关系退款与榜单配额。'.repeat(400)}}]};return{page,batch:conversationBatch('360dc294-eeda-4217-98fd-af12ee9b50c2',page,undefined,400)};};
function checkFits(packed:ReturnType<typeof sessionModelInput>){const total=Buffer.byteLength(packed.transport.prompt)+Buffer.byteLength(packed.transport.input)+packed.budget.outputTokens+packed.budget.reservedTokens;assert.ok(total<=profile.contextTokens,JSON.stringify({total,...packed.budget}));assert.equal(packed.budget.inputBytes,Buffer.byteLength(packed.transport.input));assert.equal(packed.budget.promptBytes,Buffer.byteLength(packed.transport.prompt));}
test('the reported 38+100 commit case fits the complete wire prompt and JSON at the unchanged 16K limit',()=>{
 const rows=[workspace('shared-hourly-gift-statistics-production-20261124',38,true),workspace('relationship-rework-v1')],{batch}=history();
 const packed=sessionModelInput(rows,[rows[1].key],[{agentId:'360dc294-eeda-4217-98fd-af12ee9b50c2',evidence:batch.evidence.slice(0,9),complete:false}],true,'【关系，退款】需求',undefined,profile,policy);checkFits(packed);
 assert.equal(packed.workspaces.length,1);assert.ok(packed.workspaces[0].evidence.some(e=>e.kind==='commit'));assert.ok(packed.workspaces[0].evidence.some(e=>e.kind==='diff'));assert.equal(packed.workspaces[0].coverage,'partial');assert.ok(packed.conversations[0].evidence.length>0);assert.ok(packed.budget.selectedSources<packed.budget.totalSources);
 const input=JSON.parse(packed.transport.input);assert.equal(input.workspaces.length,2);assert.ok(input.workspaces[0].summary);assert.equal(input.changedWorkspaces.length,1);
});
test('four cold large Workspaces retain independent substantive evidence instead of exhausting the later ones',()=>{
 const rows=Array.from({length:4},(_,i)=>workspace('workspace-'+i)),{batch}=history(),packed=sessionModelInput(rows,rows.map(w=>w.key),[{agentId:'agent',evidence:batch.evidence,complete:false}],true,'主需求',undefined,profile,policy);checkFits(packed);
 assert.equal(packed.workspaces.length,4);for(const row of packed.workspaces){assert.ok(row.evidence.some(e=>e.kind!=='hint'));const original=rows.find(w=>w.key===row.key)!;assert.ok(row.evidence.every(e=>original.material.evidence.some(source=>source.id===e.id)));}
});
test('JSON escaping, Unicode and large notes cannot push the actual serialized request over its limit',()=>{
 const rows=[workspace('转义与字符😀')];rows[0].material.evidence.unshift({id:'goal:unicode',kind:'goal',text:'处理退款与关系边界。'.repeat(400)},{id:'note:quoted',kind:'note',text:'"\\\r\n😀中文'.repeat(3000)});
 const packed=sessionModelInput(rows,[rows[0].key],[],true,'😀'.repeat(1000),undefined,profile,policy);checkFits(packed);assert.equal(packed.partial,true);assert.ok(packed.workspaces[0].evidence.some(e=>e.kind==='goal'));
});
test('budgeted public fragments keep an exact contiguous checkpoint and never acknowledge the remaining suffix',()=>{
 const rows=[workspace('relationship')],{page,batch}=history(),packed=sessionModelInput(rows,[rows[0].key],[{agentId:'agent',evidence:batch.evidence,complete:false}],true,'需求',undefined,profile,policy);checkFits(packed);
 const consumed=packed.conversations[0].evidence;assert.ok(consumed.length>0&&consumed.length<batch.evidence.length);assert.deepEqual(consumed,batch.evidence.slice(0,consumed.length));
 const checkpoint=batch.checkpoints.get(consumed.at(-1)!.id)!;assert.ok(checkpoint.pendingMessage);const resumed=conversationBatch('360dc294-eeda-4217-98fd-af12ee9b50c2',page,{agentId:'agent',brief:'已有摘要',items:[],evidence:[],updatedAt:'',complete:false,...checkpoint},400);assert.equal(resumed.evidence[0].id,batch.evidence[consumed.length].id);
});
test('an output reservation larger than the context is a configuration error rather than an oversized model request',()=>{
 const row=workspace('one');assert.throws(()=>sessionModelInput([row],[row.key],[],true,'',undefined,{...profile,contextTokens:2048,outputTokens:2048},policy),/context_allocation_invalid/);
});
