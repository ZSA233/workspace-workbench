import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { fenceLanguage, syntaxKind, syntaxLanguages, type SyntaxDocument, type SyntaxLine } from '../../shared/code-syntax.ts';
import type { MarkdownNode } from '../../shared/document.ts';
const require=createRequire(import.meta.url),Prism=require('prismjs/components/prism-core');
require('prismjs/components/')(syntaxLanguages);
const MarkdownIt=require('markdown-it');
const markdown=new MarkdownIt({html:false,linkify:false,typographer:false});
/** Flatten without changing any source characters, including CRLF and empty lines. */
function tokenize(text:string,language:string):SyntaxDocument {
  const lines:SyntaxLine[]=text.split(/\r\n|\n|\r/).map(code=>({code,spans:[]}));
  if(!Prism.languages[language])return {language,state:'plain',reason:'unknown_language',lines};
  let row=0,column=0,count=0,previousCR=false;
  const append=(content:string,types:string[])=>{
    const endsCR=content.endsWith('\r');if(previousCR&&content.startsWith('\n'))content=content.slice(1);previousCR=endsCR;
    const pieces=content.split(/\r\n|\n|\r/),kind=syntaxKind(types);
    for(let i=0;i<pieces.length;i++){
      const length=pieces[i].length,line=lines[row];
      if(length&&kind!=='plain'){
        if(++count>100000)throw Error('syntax_budget');
        const previous=line.spans.at(-1);
        if(previous?.kind===kind&&previous.end===column)previous.end+=length;else line.spans.push({start:column,end:column+length,kind});
      }
      column+=length;if(i<pieces.length-1){row++;column=0;}
    }
  };
  const walk=(token:any,types:string[]=[])=>{
    if(typeof token==='string')append(token,types);
    else if(Array.isArray(token))for(const child of token)walk(child,types);
    else walk(token.content,[...types,...(Array.isArray(token.alias)?token.alias:token.alias?[token.alias]:[]),token.type]);
  };
  walk(Prism.tokenize(text,Prism.languages[language]));
  for(const line of lines)if(line.code.length>12000||line.spans.length>2048)line.spans=[];
  return {language,state:'ready',lines};
}
function markdownTree(text:string):MarkdownNode[]{
  let budget=0,codeLines=0,images=0;
  const convert=(tokens:any[]):MarkdownNode[]=>tokens.map(token=>{
    if(++budget>2500||token.type==='image'&&++images>16)throw Error('markdown_preview_limit');
    const node:MarkdownNode={type:token.type,tag:token.tag,content:token.content,...(token.attrs?{attrs:Object.fromEntries(token.attrs)}:{}),level:token.nesting};
    if(token.children)node.children=convert(token.children);
    if(token.type==='fence'||token.type==='code_block'){
      codeLines+=token.content.split(/\r\n|\r|\n/).length;
      if(codeLines>1200||token.content.length>128*1024)throw Error('markdown_preview_limit');
      node.lines=tokenize(token.content,token.type==='fence'?fenceLanguage(token.info):'plain').lines;
    }
    return node;
  });
  return convert(markdown.parse(text,{}));
}
parentPort!.on('message',({id,text,language,renderMarkdown})=>{
  try{const result=tokenize(text,language);let nodes:MarkdownNode[]|undefined;
    if(renderMarkdown)try{nodes=markdownTree(text);}catch{result.state='plain';result.reason='markdown_preview_limit';}
    parentPort!.postMessage({id,result,...(nodes?{markdown:nodes}:{})});}
  catch(error){parentPort!.postMessage({id,error:String(error),...(error instanceof Error&&error.message==='syntax_budget'?{reason:'syntax_budget'}:{})});}
});
