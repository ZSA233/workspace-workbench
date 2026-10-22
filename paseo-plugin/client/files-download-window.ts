import { FILE_CHUNK_BYTES } from '../shared/files.ts';
import { checksum, decode } from './files-platform.ts';
/** Two bounded data requests per file; the store runs at most two files. */
export async function downloadWindow(options: { offset: number; size: number; check(): void; read(offset: number): Promise<any>; consume(offset: number, bytes: Uint8Array, digest: string): Promise<void> }) {
  let next=options.offset;
  const pending: Promise<{offset:number;value?:any;error?:unknown}>[]=[];
  const fill=()=>{while(pending.length<2 && next<options.size){options.check();const offset=next;next+=FILE_CHUNK_BYTES;pending.push(options.read(offset).then(value=>({offset,value}),error=>({offset,error})));}};
  try{
    fill();
    while(pending.length){
      const result=await pending.shift()!;options.check();if(result.error)throw result.error;
      const chunk=result.value,bytes=decode(chunk.data);
      if(chunk.offset!==result.offset || chunk.size!==options.size || bytes.length!==Math.min(FILE_CHUNK_BYTES,options.size-result.offset) || checksum(bytes)!==chunk.sha256)throw new Error('Download chunk verification failed');
      await options.consume(result.offset,bytes,chunk.sha256);options.check();fill();
    }
  }finally{await Promise.all(pending);}
}
