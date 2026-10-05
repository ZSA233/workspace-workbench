/** No DOM, regular-expression grammar, or host dependency. UTF-16 ranges preserve source exactly. */
export const NATIVE_SYNTAX_LIMITS = Object.freeze({lineChars:2048,lineSpans:96,batchChars:4096,batchMs:4,cacheLines:256,cacheChars:128*1024,cacheSpans:16*1024,contextRows:10,version:1});
export type NativeLanguage='go'|'javascript'|'typescript'|'json';
export type SyntaxKind='plain'|'keyword'|'string'|'comment'|'number';
export type SyntaxSpan={start:number;end:number;kind:SyntaxKind};
const go=new Set('break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var true false nil'.split(' '));
const js=new Set('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await true false null undefined'.split(' '));
const ts=new Set([...js,...'abstract any as asserts bigint boolean constructor declare enum implements infer interface is keyof module namespace never number object override private protected public readonly require satisfies static string symbol type unknown'.split(' ')]);
const json=new Set(['true','false','null']);
const letter=(c:string)=>!!c&&(c>='a'&&c<='z'||c>='A'&&c<='Z'||c==='_'||c==='$'||c.charCodeAt(0)>127);
const digit=(c:string)=>!!c&&c>='0'&&c<='9';
export function nativeLanguage(language:string):NativeLanguage|null{return ['go','javascript','typescript','json'].includes(language)?language as NativeLanguage:null;}
export function scanNativeLine(code:string,language:NativeLanguage,shouldYield:()=>boolean=()=>false):SyntaxSpan[]|null{
 if(code.length>NATIVE_SYNTAX_LIMITS.lineChars)return null;
 const spans:SyntaxSpan[]=[];const keywords=language==='go'?go:language==='typescript'?ts:language==='json'?json:js;
 const emit=(start:number,end:number,kind:SyntaxKind)=>{const last=spans.at(-1);if(last?.kind===kind)last.end=end;else spans.push({start,end,kind});};
 let i=0;
 while(i<code.length){
  if(shouldYield())return null;
  const start=i,c=code[i];let kind:SyntaxKind='plain';i++;
  if(language!=='json'&&c==='/'&&code[i]==='/'){emit(start,code.length,'comment');break;}
  if(language!=='json'&&c==='/'&&code[i]==='*'){
   i++;let closed=false;while(i<code.length){if(shouldYield())return null;if(code[i]==='*'&&code[i+1]==='/'){i+=2;closed=true;break;}i++;}
   // Cross-line constructs are deliberately plain, including their uncertain remainder.
   if(!closed){emit(start,code.length,'plain');break;}kind='comment';
  }else if(c==='"'||language!=='json'&&(c==="'"||c==='`')){
   let closed=false,template=false;
   while(i<code.length){if(shouldYield())return null;const next=code[i++];if(next===c){closed=true;break;}if(c==='`'&&code[i-1]==='$'&&code[i]==='{')template=true;if(next==='\\'&&!(c==='`'&&language==='go'))i=Math.min(code.length,i+1);}
   if(!closed){emit(start,code.length,'plain');break;}kind=template?'plain':'string';
  }else if(letter(c)){
   while(i<code.length&&(letter(code[i])||digit(code[i]))){if(shouldYield())return null;i++;}
   if(keywords.has(code.slice(start,i)))kind='keyword';
  }else if(digit(c)){
   // Consume a bounded numeric candidate. Incomplete/ambiguous literals remain plain.
   while(i<code.length&&(letter(code[i])||digit(code[i])||code[i]==='.'||code[i]==='+'&&'eEpP'.includes(code[i-1])||code[i]==='-'&&'eEpP'.includes(code[i-1]))){if(shouldYield())return null;i++;}
   const literal=code.slice(start,i).replaceAll('_','');
   if(Number.isFinite(Number(literal)))kind='number';
  }else if(language!=='json'&&c==='/'){
   // A slash can introduce a regexp; avoid coloring its contents as normal JS code.
   if(language!=='go'){emit(start,code.length,'plain');break;}
  }
  emit(start,i,kind);if(spans.length>NATIVE_SYNTAX_LIMITS.lineSpans)return null;
 }
 return spans.length>NATIVE_SYNTAX_LIMITS.lineSpans?null:spans;
}
/** Clip existing ranges and change backgrounds without parsing substrings. */
export function nativeRenderSegments(code:string,spans:readonly SyntaxSpan[]|null|undefined,change?:readonly[number,number]){
 const source=spans?.length?spans:[{start:0,end:code.length,kind:'plain' as const}];
 const result:Array<SyntaxSpan&{changed:boolean}>=[];
 for(const span of source){let start=span.start;const ends=change?[change[0],change[1],span.end].filter(end=>end>start&&end<=span.end):[span.end];
  for(const end of ends){if(end<=start)continue;result.push({start,end,kind:span.kind,changed:!!change&&start>=change[0]&&end<=change[1]});start=end;}
 }
 return result;
}
