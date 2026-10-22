import type { FileHandle } from 'node:fs/promises';
import { SYNTAX_PROTOCOL, SYNTAX_SOURCE_BYTES, languageForPath } from '../../shared/code-syntax.ts';
import type { DocumentPage, DocumentSyntax } from '../../shared/document.ts';
import { FileRoots, fileVersion, type FileRoot } from './file-roots.ts';
import { WorkbenchError } from './storage.ts';
import { SyntaxService } from './syntax-service.ts';
const PAGE_BYTES=256*1024;
async function bytes(handle:FileHandle,offset:number,length:number){const buffer=Buffer.alloc(Math.max(0,length));let count=0;while(count<buffer.length){const read=await handle.read(buffer,count,buffer.length-count,offset+count);if(!read.bytesRead)break;count+=read.bytesRead;}return buffer.subarray(0,count);}
function encoding(data:Buffer){return data[0]===255&&data[1]===254?{name:'utf-16le',bom:2}:data[0]===254&&data[1]===255?{name:'utf-16be',bom:2}:data[0]===239&&data[1]===187&&data[2]===191?{name:'utf-8',bom:3}:{name:'utf-8',bom:0};}
function decode(data:Buffer,name:string,eof:boolean){
  let length=data.length;
  if(!eof&&name.startsWith('utf-16')){length-=length%2;if(length>=2){const tail=name==='utf-16le'?data.readUInt16LE(length-2):data.readUInt16BE(length-2);if(tail>=0xd800&&tail<=0xdbff)length-=2;}}
  else if(!eof){for(let i=0;i<Math.min(4,data.length);i++){try{new TextDecoder(name,{fatal:true}).decode(data.subarray(0,length));break;}catch{length--;}}}
  // Keep CRLF together so page line offsets agree with full-source tokens.
  if(!eof&&length){const tail=name==='utf-16le'?data.readUInt16LE(length-2):name==='utf-16be'?data.readUInt16BE(length-2):data[length-1];if(tail===13)length-=name.startsWith('utf-16')?2:1;}
  return {text:new TextDecoder(name,{ignoreBOM:true}).decode(data.subarray(0,length)),length};
}
export class Documents {
  private reads=new Map<string,AbortController>();private cancelled=new Set<string>();
  readonly roots:FileRoots;readonly syntax:SyntaxService;
  constructor(roots:FileRoots,syntax:SyntaxService){this.roots=roots;this.syntax=syntax;}
  cancel(context:FileRoot,requestId:string){const key=context.instance+':'+requestId;this.cancelled.add(key);if(this.cancelled.size>256)this.cancelled.delete(this.cancelled.values().next().value!);this.reads.get(key)?.abort();return {cancelled:true};}
  private async opened<T>(context:FileRoot,path:string,version:string|undefined,read:(handle:FileHandle,size:number,version:string)=>Promise<T>):Promise<T>{
    const handle=await this.roots.read(context,path);
    try{const before=await handle.stat(),identity=fileVersion(before);if(version&&version!==identity)throw new WorkbenchError('file_source_changed','File changed; refresh to read the new version');
      const result=await read(handle,before.size,identity);
      if(fileVersion(await handle.stat())!==identity)throw new WorkbenchError('file_source_changed','File changed while reading');
      const current=await this.roots.context(context.workspace.id,context.instance);const actual=await this.roots.read(current,path);try{if(fileVersion(await actual.stat())!==identity)throw new WorkbenchError('file_source_changed','File changed while reading');}finally{await actual.close();}
      return result;
    }finally{await handle.close();}
  }
  stat(context:FileRoot,path:string,version?:string){return this.opened(context,path,version,async(_handle,size,identity)=>({version:identity,size}));}
  page(context:FileRoot,path:string,offset:number,version?:string):Promise<DocumentPage>{
    return this.opened(context,path,version,async(handle,size,identity)=>{
      if(offset>size)throw new WorkbenchError('file_offset_invalid','Offset is past the end of the file');
      const prefix=await bytes(handle,0,Math.min(size,4096)),format=encoding(prefix);
      const binary=format.name==='utf-8'&&prefix.includes(0);
      const start=offset;
      if(format.name.startsWith('utf-16')&&start%2)throw new WorkbenchError('file_offset_invalid','Invalid UTF-16 boundary');
      const data=binary?Buffer.alloc(0):await bytes(handle,start,Math.min(PAGE_BYTES,size-start));
      // A newline-heavy file must not create hundreds of thousands of UI rows in one page.
      let end=data.length,lines=0,previous=0;
      const step=format.name.startsWith('utf-16')?2:1;
      for(let i=0;i+step<=data.length;i+=step){const unit=step===1?data[i]:format.name==='utf-16le'?data.readUInt16LE(i):data.readUInt16BE(i);if((unit===13||unit===10&&previous!==13)&&++lines===4000){end=i+step;if(unit===13&&i+2*step<=data.length){const next=step===1?data[i+step]:format.name==='utf-16le'?data.readUInt16LE(i+step):data.readUInt16BE(i+step);if(next===10)end+=step;}break;}previous=unit;}
      const part=decode(data.subarray(0,end),format.name,start+end>=size);
      return {protocol:SYNTAX_PROTOCOL,workspaceId:context.workspace.id,instance:context.instance,path,version:identity,size,offset,nextOffset:binary?size:start+part.length,text:part.text,encoding:format.name,binary,eof:binary||start+part.length>=size};
    });
  }
  async highlight(context:FileRoot,path:string,version:string,lineStart:number,count:number,markdown:boolean,signal?:AbortSignal,requestId?:string):Promise<DocumentSyntax>{
    const key=context.instance+':'+requestId,controller=new AbortController();
    if(requestId&&this.cancelled.has(key))throw new WorkbenchError('observer_cancelled','Document read cancelled');
    if(requestId)this.reads.set(key,controller);
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try{return await this.opened(context,path,version,async(handle,size,identity)=>{
      const language=languageForPath(path);
      if(size>SYNTAX_SOURCE_BYTES)return {version:identity,state:'plain',reason:'large_file',language,lines:{}};
      if(language==='plain')return {version:identity,state:'plain',reason:'unknown_language',language,lines:{}};
      if(controller.signal.aborted)throw new WorkbenchError('observer_cancelled','Document read cancelled');
      const cacheIdentity=context.instance+':'+identity,renderMarkdown=markdown&&language==='markdown';
      const cached=this.syntax.lookup(context.workspace.id,cacheIdentity,language,renderMarkdown);
      if(cached)return {version:identity,state:cached.state,reason:cached.reason,language,lines:Object.fromEntries(cached.lines.slice(lineStart-1,lineStart-1+count).map((line,index)=>[String(lineStart+index),line])),...(cached.markdown?{markdown:cached.markdown}:{})};
      const data=await bytes(handle,0,size),format=encoding(data);
      if(format.name==='utf-8'&&data.includes(0))return {version:identity,state:'plain',reason:'binary',language,lines:{}};
      const source=decode(data,format.name,true).text;
      await this.roots.context(context.workspace.id,context.instance);
      const result=await this.syntax.parse(context.workspace.id,cacheIdentity,source,language,renderMarkdown,controller.signal);
      return {version:identity,state:result.state,reason:result.reason,language,lines:Object.fromEntries(result.lines.slice(lineStart-1,lineStart-1+count).map((line,index)=>[String(lineStart+index),line])),...(result.markdown?{markdown:result.markdown}:{})};
    });}finally{signal?.removeEventListener('abort',abort);if(this.reads.get(key)===controller)this.reads.delete(key);}
  }
  asset(context:FileRoot,path:string,offset:number,version?:string){
    return this.opened(context,path,version,async(handle,size,identity)=>{
      if(size>4*1024*1024)throw new WorkbenchError('image_preview_limit','Image exceeds the 4 MiB inline preview budget; use Download');
      if(offset>size)throw new WorkbenchError('file_offset_invalid','Invalid image offset');
      const prefix=await bytes(handle,0,16);
      const mime=prefix.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':prefix[0]===255&&prefix[1]===216?'image/jpeg':/^GIF8[79]a/.test(prefix.toString('ascii'))?'image/gif':prefix.toString('ascii',0,4)==='RIFF'&&prefix.toString('ascii',8,12)==='WEBP'?'image/webp':null;
      if(!mime)throw new WorkbenchError('image_preview_unsupported','Inline preview supports PNG, JPEG, GIF and WebP');
      const data=await bytes(handle,offset,Math.min(PAGE_BYTES,size-offset));
      return {version:identity,mime,size,data:data.toString('base64'),offset,nextOffset:offset+data.length,eof:offset+data.length===size};
    });
  }
}
