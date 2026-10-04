import { access, link, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, stable, type Json } from './storage.ts';
/** Snapshot identity contains execution facts only, never observation timestamps. */
export async function publishEnvironmentSnapshot(stateRoot:string,content:Json){
  const snapshotId=hash(stable(content));
  const directory=join(stateRoot,'environments'),file=join(directory,`snapshot-${snapshotId}.json`);
  const snapshot={...content,snapshotId,environment:{...content.environment,variables:{...content.environment.variables,WORKBENCH_ENVIRONMENT_FILE:file}}};
  try {await access(file);return snapshot;}catch{}
  await mkdir(directory,{recursive:true,mode:0o700});
  const temporary=join(directory,`.${randomUUID()}.tmp`);
  try{
    const handle=await open(temporary,'wx',0o600);
    try{await handle.writeFile(JSON.stringify(snapshot));await handle.sync();}finally{await handle.close();}
    try{await link(temporary,file);}catch(error){if((error as NodeJS.ErrnoException).code !== 'EEXIST')throw error;}
    const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}
  }finally{await unlink(temporary).catch(()=>{});}
  return snapshot;
}
