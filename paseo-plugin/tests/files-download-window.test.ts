import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { downloadWindow } from '../client/files-download-window.ts';
import { FileTransferStore } from '../client/files-store.ts';
import { checksum, encode, DownloadStaging } from '../client/files-platform.ts';
import { FILE_CHUNK_BYTES } from '../shared/files.ts';
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('two file windows bound data requests to four and consume out-of-order replies in source order',async()=>{
  let inFlight=0,peak=0;const size=FILE_CHUNK_BYTES*7+29;
  const transfer=async()=>{const offsets:number[]=[],digest=createHash('sha256');await downloadWindow({offset:0,size,check(){},read:async offset=>{peak=Math.max(peak,++inFlight);await delay(offset% (2*FILE_CHUNK_BYTES)===0?8:1);const bytes=new Uint8Array(Math.min(FILE_CHUNK_BYTES,size-offset)).fill(offset/FILE_CHUNK_BYTES);inFlight--;return {offset,size,data:encode(bytes),sha256:checksum(bytes)};},consume:async(offset,bytes)=>{offsets.push(offset);digest.update(bytes);await delay(2);}});return {offsets,hash:digest.digest('hex')};};
  const [a,b]=await Promise.all([transfer(),transfer()]);assert.equal(peak,4);assert.equal(a.hash,b.hash);assert.deepEqual(a.offsets,Array.from({length:8},(_,n)=>n*FILE_CHUNK_BYTES));
});

test('pausing fences late reads and verification rejects incomplete chunks before staging',async()=>{
  let stopped=false,writes=0;const bytes=new Uint8Array(FILE_CHUNK_BYTES);
  const pending=downloadWindow({offset:0,size:bytes.length*2,check(){if(stopped)throw Error('paused');},read:async offset=>{await delay(10);return {offset,size:bytes.length*2,data:encode(bytes),sha256:checksum(bytes)};},consume:async()=>{writes++;}});
  stopped=true;await assert.rejects(pending,/paused/);assert.equal(writes,0);
  await assert.rejects(downloadWindow({offset:0,size:bytes.length,check(){},read:async offset=>({offset,size:bytes.length,data:encode(bytes.subarray(0,3)),sha256:checksum(bytes.subarray(0,3))}),consume:async()=>{writes++;}}),/verification/);assert.equal(writes,0);
});

test('combined reads confirm only durable staging, reconcile a lost response and commit after close',async()=>{
  const supported=DownloadStaging.supported,open=DownloadStaging.open,remove=DownloadStaging.remove,web=globalThis as any,bridge=web.WorkbenchFileSave;
  const size=FILE_CHUNK_BYTES*5+17,parts=new Map<number,Uint8Array>(),events:string[]=[];let staged=0,lost=false,acks=0;
  const task:any={id:'window-recovery',direction:'download',workspaceId:'w',instance:'one',workspaceName:'W',path:'',name:'bytes',size,offset:0,state:'active',createdAt:1,updatedAt:1};
  const digest=createHash('sha256'),expected=createHash('sha256');for(let offset=0;offset<size;offset+=FILE_CHUNK_BYTES)expected.update(new Uint8Array(Math.min(FILE_CHUNK_BYTES,size-offset)).fill(offset/FILE_CHUNK_BYTES));
  DownloadStaging.supported=()=>true;DownloadStaging.remove=async()=>{};
  DownloadStaging.open=async()=>({offset:async()=>staged,write:async(offset:number,bytes:Uint8Array)=>{assert.equal(offset,staged);await delay(1);parts.set(offset,bytes);staged+=bytes.length;},exportTo:async(output:any)=>{for(const bytes of parts.values())await output.write(bytes);await output.close();}} as any);
  web.WorkbenchFileSave={open:async()=>{}};
  const store=new FileTransferStore('window-recovery') as any;store.readWindow=true;store.tasks.set(task.id,{...task});
  store.destinations.set(task.id,{discard:async()=>{},open:async()=>({write:async(bytes:Uint8Array)=>{digest.update(bytes);},close:async()=>{events.push('closed');},abort:async()=>{events.push('abort');}})});
  store.rpc=async(input:any)=>{
    if(input.action==='task')return {...task};
    if(input.action==='read'){
      assert.ok(input.confirmedOffset<=staged,'a read never confirms an unclosed staging chunk');task.offset=Math.max(task.offset,input.confirmedOffset);task.updatedAt++;
      if(input.offset===FILE_CHUNK_BYTES*2&&!lost){lost=true;throw Error('network response lost after durable confirmation');}
      await delay(input.offset% (FILE_CHUNK_BYTES*2)?1:8);const bytes=new Uint8Array(Math.min(FILE_CHUNK_BYTES,size-input.offset)).fill(input.offset/FILE_CHUNK_BYTES);return {data:encode(bytes),sha256:checksum(bytes),offset:input.offset,size,confirmedOffset:task.offset};
    }
    if(input.action==='ack'){acks++;assert.ok(input.offset<=staged);task.offset=Math.max(task.offset,input.offset);task.state='ready_to_save';return {...task,updatedAt:++task.updatedAt};}
    if(input.action==='control'){assert.deepEqual(events,['closed']);task.state='complete';return {...task,updatedAt:++task.updatedAt};}
    throw Error(input.action);
  };
  try{await store.receive({...task});assert.equal(acks,1);assert.equal(task.offset,size);assert.equal(task.state,'complete');assert.equal(digest.digest('hex'),expected.digest('hex'));assert.equal(lost,true);}
  finally{DownloadStaging.supported=supported;DownloadStaging.open=open;DownloadStaging.remove=remove;web.WorkbenchFileSave=bridge;}
});
