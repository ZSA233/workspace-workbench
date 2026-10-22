import { relative, join } from 'node:path';
import { SYNTAX_PROTOCOL, SYNTAX_SOURCE_BYTES, languageForPath, type DiffSyntax, type SyntaxLine } from '../../shared/code-syntax.ts';
import { FileRoots, fileVersion } from './file-roots.ts';
import { SyntaxService } from './syntax-service.ts';
import { Git } from './git.ts';
import { validateDiffPath } from './file-diff.ts';
import { hash, type Json } from './storage.ts';
import {workspaceInstanceKey} from '../../shared/workspace-lineage.ts';
import type { Workspaces } from './workspaces.ts';
export type SyntaxCoordinates={oldLine:number|null;newLine:number|null;content:string};
export function patchCoordinates(patch:string):SyntaxCoordinates[]{
  let old=0,next=0,active=false;const rows:SyntaxCoordinates[]=[];
  for(const line of patch.replace(/\r\n/g,'\n').split('\n')){const header=/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);if(header){old=+header[1];next=+header[2];active=true;continue;}if(!active)continue;
    if(line[0]===' ')rows.push({oldLine:old++,newLine:next++,content:line.slice(1)});
    else if(line[0]==='-')rows.push({oldLine:old++,newLine:null,content:line.slice(1)});
    else if(line[0]==='+')rows.push({oldLine:null,newLine:next++,content:line.slice(1)});
  }return rows;
}
/** Source text is acquired independently for each frozen side, never from patch fragments. */
export async function highlightDiff(workspaces:Workspaces,syntax:SyntaxService,workspace:Json,git:Git,patch:Json,rows:SyntaxCoordinates[],signal?:AbortSignal):Promise<DiffSyntax>{
  const result:DiffSyntax={protocol:SYNTAX_PROTOCOL,patchDigest:patch.patchDigest||hash(patch.patch),workspaceInstance:workspaceInstanceKey(workspace as Json&{id:string}),sources:{},left:{},right:{},state:'ready'};
  if(patch.binary||patch.truncated||/^(?:new file|deleted file|old|new) mode (?:160000|120000)/m.test(patch.patch))return {...result,state:'plain',reason:'unsupported_source'};
  const roots=new FileRoots(workspaces);
  const readSide=async(side:'left'|'right')=>{
    const path=side==='left'?patch.oldPath||patch.path:patch.path;validateDiffPath(path);
    const revision=side==='left'?patch.left:patch.right;
    if(side==='left'&&(!revision||/^new file mode /m.test(patch.patch))||side==='right'&&/^deleted file mode /m.test(patch.patch))return;
    let text:string|undefined,identity:string,document:ReturnType<SyntaxService['lookup']>;
    const language=languageForPath(path);
    if(language==='plain'){result.state='plain';result.reason||='unknown_language';return;}
    if(!revision){
      const context=await roots.context(workspace.id),local=relative(context.root,join(git.path,path)).replaceAll('\\','/');
      const handle=await roots.read(context,local);
      try{const stat=await handle.stat();if(stat.size>SYNTAX_SOURCE_BYTES)throw Error('large_file');identity=context.instance+':'+fileVersion(stat);document=syntax.lookup(workspace.id,identity,language);if(!document){const data=Buffer.alloc(stat.size);const read=await handle.read(data,0,data.length,0);if(read.bytesRead!==data.length||fileVersion(await handle.stat())!==fileVersion(stat))throw Error('source_changed');text=data.toString('utf8');}}
      finally{await handle.close();}
    }else{
      if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision))throw Error('source_not_frozen');
      const object=await git.text(['rev-parse','--verify',`${revision}:${path}`]);
      if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(object))throw Error('source_unavailable');
      identity=git.path+':'+object;document=syntax.lookup(workspace.id,identity,language);
      if(!document){if(Number(await git.text(['cat-file','-s',object]))>SYNTAX_SOURCE_BYTES)throw Error('large_file');text=(await git.run(['cat-file','blob',object],true,{maxBytes:SYNTAX_SOURCE_BYTES})).stdout;}
    }
    if(text?.includes('\0'))throw Error('binary');
    result.sources![side]={path,version:identity};
    document??=await syntax.parse(workspace.id,identity,text!,language,false,signal);
    if(document.state!=='ready'){result.state='plain';result.reason=document.reason;}
    let bytes=0;
    for(const row of rows){const number=side==='left'?row.oldLine:row.newLine;if(number==null)continue;const line=document.lines[number-1];if(line?.code!==row.content)continue;
      bytes+=Buffer.byteLength(JSON.stringify(line));if(bytes>768*1024){result.reason='token_response_limit';break;}result[side][String(number)]=line as SyntaxLine;
    }
  };
  for(const side of ['left','right'] as const)try{await readSide(side);}catch(error){result.state='plain';result.reason=error instanceof Error?error.message:'source_unavailable';}
  return result;
}
