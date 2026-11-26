import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { saveChatMediaFile } from '../client/save-chat-media.ts';
import { CHAT_MEDIA_CHUNK_BYTES, type ChatMediaChunk } from '../shared/chat-media-limits.ts';

const revision='b'.repeat(64),token='00000000-1111-2222-3333-444444444444';
const bytes=Buffer.alloc(CHAT_MEDIA_CHUNK_BYTES+31,23);
const file={assetId:'a'.repeat(64),name:'跨端附件.pdf',mimeType:'application/pdf',size:bytes.length,available:true};
const metadata=async()=>({url:'/api/files/download?token='+token,serverId:'fixture-host',name:file.name,size:file.size,revision});
async function chunk(offset:number):Promise<ChatMediaChunk> {
  const value=bytes.subarray(offset,offset+CHAT_MEDIA_CHUNK_BYTES);
  return {offset,size:bytes.length,revision,base64:value.toString('base64'),sha256:createHash('sha256').update(value).digest('hex')};
}
function environment(values:Record<string,unknown>) {
  const original=new Map(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const [key,value] of Object.entries(values))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  return ()=>{for(const [key,value] of original){if(value)Object.defineProperty(globalThis,key,value);else delete (globalThis as any)[key];}};
}
test('Pocket retains its native save owner, opens from the gesture and aborts corrupted reads',async()=>{
  const events:string[]=[],written:Uint8Array[]=[];
  const restore=environment({WorkbenchFileSave:{capabilities:{multipleDestinations:true},open:()=>{
    events.push('picker');return Promise.resolve({write:async(value:Uint8Array)=>{written.push(value);},close:async()=>{events.push('close');},abort:async()=>{events.push('abort');}});
  }},navigator:{userAgent:'AccessPocket/0.3.8'},fetch:()=>{throw Error('native owner must not delegate');}});
  try {
    const pending=saveChatMediaFile(file,async()=>{events.push('metadata');return metadata();},chunk);
    assert.deepEqual(events,['picker']);await pending;
    assert.deepEqual(events,['picker','metadata','close']);assert.deepEqual(Buffer.concat(written),bytes);
    events.length=0;
    await assert.rejects(saveChatMediaFile(file,metadata,async offset=>({...await chunk(offset),sha256:'0'.repeat(64)})),/校验失败/);
    assert.deepEqual(events,['picker','abort']);
    (globalThis as any).WorkbenchFileSave.open=()=>Promise.reject(Error('Save cancelled'));
    let reads=0;await saveChatMediaFile(file,async()=>{reads++;return metadata();},chunk);assert.equal(reads,0);
  } finally {restore();}
});
test('ordinary browser downloads exact RPC bytes when the native host serves an HTML SPA for Access capabilities',async()=>{
  const downloads:Array<{url:string;name:string}>=[],blobs:Blob[]=[];
  class BrowserURL extends URL {static createObjectURL(blob:Blob){blobs.push(blob);return 'blob:fixture';}static revokeObjectURL(){}}
  const restore=environment({WorkbenchFileSave:undefined,showSaveFilePicker:undefined,navigator:{userAgent:'Chrome'},URL:BrowserURL,
    location:{href:'https://paseo.test/',origin:'https://paseo.test'},
    document:{body:{appendChild(){}},createElement(){return {href:'',download:'',click(){downloads.push({url:this.href,name:this.download});},remove(){}};}},
    fetch:async()=>({ok:true,status:200,headers:new Headers({'content-type':'text/html; charset=utf-8'}),json(){throw Error('HTML must not be parsed');}})});
  try {
    await saveChatMediaFile(file,metadata,chunk);
    assert.deepEqual(downloads,[{url:'blob:fixture',name:file.name}]);assert.deepEqual(Buffer.from(await blobs[0].arrayBuffer()),bytes);
  }finally{restore();}
});
test('an uncertain Access handoff never falls through to a second save or an RPC byte read',async()=>{
  const requests:string[]=[];let reads=0;
  const restore=environment({WorkbenchFileSave:undefined,showSaveFilePicker:undefined,navigator:{userAgent:'AccessPocket/0.3.8'},
    location:{href:'https://paseo.test/',origin:'https://paseo.test'},document:{},
    fetch:async(path:string)=>{requests.push(path);if(path.endsWith('capabilities'))return {ok:true,status:200,json:async()=>({download_handoff_version:1,entry_server_id:'fixture-host'})};throw Error('connection lost after handoff');}});
  try {
    await assert.rejects(saveChatMediaFile(file,metadata,async offset=>{reads++;return chunk(offset);}),/connection lost/);
    assert.equal(requests.length,2);assert.equal(reads,0);
  }finally{restore();}
});
