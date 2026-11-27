import {constants,type Stats} from 'node:fs';
import {lstat,open,readlink,realpath} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import {hash} from './storage.ts';

const limit=128*1024;
const signature=(s:Stats)=>[s.dev,s.ino,s.mode,s.size,s.mtimeMs,s.ctimeMs].join(':');
/** Content revisions exclude touch times. Unsupported/oversize/racing files
 * retain conservative metadata revisions and cannot prove full coverage. */
export async function materialFile(root:string,name:string,signal?:AbortSignal,deadline?:number){
 let stat:Stats|undefined;
 const unavailable=()=>({revision:['unverified',stat?signature(stat):name],complete:false,mtime:stat?.mtimeMs});
 const check=()=>{if(signal?.aborted||deadline!==undefined&&Date.now()>=deadline)throw Error('material_file_cancelled');};
 try{
  check();const path=resolve(root,name);
  if(!path.startsWith(root+sep))return unavailable();
  stat=await lstat(path);
  const parent=await realpath(dirname(path));if(parent!==root&&!parent.startsWith(root+sep))return unavailable();
  if(stat.isSymbolicLink()){
   const value=await readlink(path);check();const after=await lstat(path);
   if(signature(stat)!==signature(after))return unavailable();
   return {revision:['link',stat.mode,hash(value)],complete:true,mtime:stat.mtimeMs};
  }
  if(!stat.isFile()||stat.size>limit)return unavailable();
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const before=await file.stat();if(signature(before)!==signature(stat)||!before.isFile())return unavailable();
   const buffer=Buffer.alloc(limit+1);let offset=0;
   while(offset<buffer.length){check();const read=await file.read(buffer,offset,buffer.length-offset,offset);if(!read.bytesRead)break;offset+=read.bytesRead;}
   check();const after=await file.stat(),current=await lstat(path);
   if(offset!==stat.size||signature(after)!==signature(stat)||signature(current)!==signature(stat))return unavailable();
   return {revision:['file',stat.mode,stat.size,hash(buffer.subarray(0,offset))],complete:true,mtime:stat.mtimeMs};
  }finally{await file.close();}
 }catch(error){
  check();if(!stat&&['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code||''))return{revision:['missing'],complete:true,mtime:undefined};
  return unavailable();
 }
}
