import test from 'node:test';
import assert from 'node:assert/strict';
import type {PaseoApi} from '@getpaseo/client';
import {samePublicConversation} from '../server/organizer/conversation-head.ts';
const api=(read:(options:any)=>any)=>({agents:{ref:()=>({timeline:{refetch:read}})}} as unknown as PaseoApi);
test('tool revisions are checked in bounded pages without inspecting private event text',async()=>{
 let calls=0;const privateItem={type:'tool_call',get text(){throw Error('private tool text must not be read');}},host=api(options=>{calls++;const seq=options.cursor.seq+100;return{epoch:'e',hasNewer:seq<300,entries:[{seqStart:seq-100,seqEnd:seq,item:privateItem}]};});
 assert.deepEqual(await samePublicConversation(host,'a',{epoch:'e',seq:0},{epoch:'e',seq:300},()=>{}),{same:true,head:{epoch:'e',seq:300}});assert.equal(calls,3);
 calls=0;const incomplete=await samePublicConversation(host,'a',{epoch:'e',seq:0},{epoch:'e',seq:1000},()=>{});assert.equal(incomplete.same,false);assert.ok(calls<=8);
});
test('new public input, assistant text, stale epochs and unexplained cursor gaps cannot verify an older preview',async()=>{
 for(const item of [{type:'user_message',text:''},{type:'assistant_message',text:'new public result'}]){const host=api(()=>({epoch:'e',hasNewer:false,entries:[{seqStart:2,seqEnd:2,item}]}));assert.equal((await samePublicConversation(host,'a',{epoch:'e',seq:1},{epoch:'e',seq:2},()=>{})).same,false);}
 const empty=api(()=>({epoch:'e',hasNewer:false,entries:[]}));assert.equal((await samePublicConversation(empty,'a',{epoch:'old',seq:1},{epoch:'e',seq:2},()=>{})).same,false);assert.equal((await samePublicConversation(empty,'a',{epoch:'e',seq:1},{epoch:'e',seq:2},()=>{})).same,false);
});
