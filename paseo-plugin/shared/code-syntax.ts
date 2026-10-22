/** Runtime-neutral syntax contract. Offsets are UTF-16 positions within a source line. */
export const SYNTAX_PROTOCOL = 1;
export const SYNTAX_SOURCE_BYTES = 2 * 1024 * 1024;
export type SyntaxKind = 'plain' | 'comment' | 'keyword' | 'string' | 'number' | 'boolean' | 'function' | 'type' | 'property' | 'tag' | 'attribute' | 'regex' | 'operator' | 'punctuation' | 'builtin' | 'constant';
export type SyntaxSpan = { start: number; end: number; kind: SyntaxKind };
export type SyntaxLine = { code: string; spans: SyntaxSpan[] };
export type SyntaxDocument = { language: string; state: 'ready' | 'plain'; reason?: string; lines: SyntaxLine[] };
export type DiffSyntax = { protocol: number; patchDigest: string; workspaceInstance?:string; sources?:Partial<Record<'left'|'right',{path:string;version:string}>>; left: Record<string, SyntaxLine>; right: Record<string, SyntaxLine>; state: 'ready' | 'plain'; reason?: string };
const extensions: Record<string, string> = {
  go:'go',js:'javascript',mjs:'javascript',cjs:'javascript',jsx:'jsx',ts:'typescript',mts:'typescript',cts:'typescript',tsx:'tsx',
  py:'python',pyw:'python',java:'java',kt:'kotlin',kts:'kotlin',swift:'swift',c:'c',h:'c',cc:'cpp',cpp:'cpp',cxx:'cpp',hpp:'cpp',hh:'cpp',cs:'csharp',rs:'rust',
  sh:'bash',bash:'bash',zsh:'bash',sql:'sql',json:'json',jsonc:'json5',json5:'json5',yml:'yaml',yaml:'yaml',toml:'toml',ini:'ini',cfg:'ini',conf:'ini',properties:'properties',env:'bash',
  html:'markup',htm:'markup',xml:'markup',svg:'markup',css:'css',scss:'scss',less:'less',md:'markdown',markdown:'markdown',mdx:'markdown',mk:'makefile',dockerfile:'docker',
};
const filenames: Record<string,string> = {dockerfile:'docker',containerfile:'docker',makefile:'makefile',gnumakefile:'makefile',gitconfig:'ini','.gitconfig':'ini','.npmrc':'ini','.yarnrc':'ini','.editorconfig':'ini','.bashrc':'bash','.zshrc':'bash','.profile':'bash','.env':'bash'};
export const syntaxLanguages = [...new Set(Object.values(extensions))];
export function languageForPath(path:string):string {
  const name=path.replaceAll('\\','/').split('/').at(-1)!.toLowerCase();
  if(typeof filenames[name]==='string')return filenames[name];
  if(name.startsWith('.env.'))return 'bash';
  if(name.startsWith('dockerfile.'))return 'docker';
  const value=extensions[name.split('.').at(-1)!];return typeof value==='string'?value:'plain';
}
export function fenceLanguage(info:string):string {
  const name=info.trim().split(/\s/)[0].toLowerCase();
  const aliases:Record<string,string>={js:'javascript',ts:'typescript',py:'python',sh:'bash',shell:'bash',shellscript:'bash',yml:'yaml',html:'markup',xml:'markup',svg:'markup',md:'markdown','c++':'cpp','c#':'csharp',cs:'csharp',dockerfile:'docker',jsonc:'json5',text:'plain',txt:'plain'};
  return typeof aliases[name]==='string'?aliases[name]:(syntaxLanguages.includes(name)?name:'plain');
}
const tokenKinds:Record<string,SyntaxKind>={comment:'comment',prolog:'comment',doctype:'comment',tag:'tag',namespace:'tag',property:'property','literal-property':'property',key:'property','attr-name':'attribute',attribute:'attribute',string:'string',char:'string','attr-value':'string',regex:'regex',url:'regex',boolean:'boolean',number:'number',date:'number',keyword:'keyword',control:'keyword',directive:'keyword',selector:'keyword',title:'keyword',bold:'keyword',italic:'keyword',function:'function','function-variable':'function','class-name':'type',type:'type',builtin:'builtin',constant:'constant',operator:'operator',important:'operator',punctuation:'punctuation'};
export function syntaxKind(types:readonly string[]):SyntaxKind {
  // Inner grammars override their containers (attributes and embedded code).
  for(let index=types.length-1;index>=0;index--){const kind=tokenKinds[types[index]];if(typeof kind==='string')return kind;}
  return 'plain';
}
export function diffLineSyntax(syntax:DiffSyntax|undefined,patchDigest:string|undefined,code:string,line?:{oldLine:number|null;newLine:number|null;kind:string},side?:'left'|'right'):SyntaxSpan[]|null|undefined {
  if(!syntax||syntax.protocol!==SYNTAX_PROTOCOL||syntax.patchDigest!==patchDigest)return undefined;
  if(!line)return null;
  const left=side==='left'||!side&&line.kind==='removed',number=left?line.oldLine:line.newLine;
  const value=number==null?undefined:(left?syntax.left:syntax.right)[String(number)];
  return value?.code===code?value.spans:null;
}
