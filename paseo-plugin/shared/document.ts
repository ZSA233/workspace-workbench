import type { SyntaxLine } from './code-syntax.ts';
export type MarkdownNode = { type:string; tag:string; content:string; attrs?:Record<string,string>; level?:number; children?:MarkdownNode[]; lines?:SyntaxLine[] };
export type DocumentPage = { protocol:number; workspaceId:string; instance:string; path:string; version:string; size:number; offset:number; nextOffset:number; text:string; encoding:string; binary:boolean; eof:boolean };
export type DocumentSyntax = { version:string; state:'ready'|'plain'; reason?:string; language:string; lines:Record<string,SyntaxLine>; markdown?:MarkdownNode[] };
export type DocumentAsset = { version:string; mime:string; size:number; data:string; offset:number; nextOffset:number; eof:boolean };
export type DocumentStat = {version:string;size:number};
export function documentLink(path:string,href:string):{path:string;fragment?:string}|null {
  if(!href||/^[a-z][a-z\d+.-]*:/i.test(href)||href.startsWith('//')||href.startsWith('/')||href.includes('\\'))return null;
  let raw:string;try{raw=decodeURIComponent(href.split('#')[0].split('?')[0]);}catch{return null;}
  if(raw.startsWith('/')||/^[a-z][a-z\d+.-]*:/i.test(raw))return null;
  const parts=path.split('/').slice(0,-1);
  if(!raw)return {path,fragment:href.split('#')[1]};
  for(const part of raw.split('/')){if(!part||part==='.')continue;if(part==='..'){if(!parts.length)return null;parts.pop();}else if(part.includes('\0')||part.includes('\\'))return null;else parts.push(part);}
  return {path:parts.join('/'),fragment:href.split('#')[1]};
}
