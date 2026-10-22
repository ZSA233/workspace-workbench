import test from 'node:test';
import assert from 'node:assert/strict';
import {SyntaxService} from '../server/backend/syntax-service.ts';
import {languageForPath,syntaxLanguages,diffLineSyntax} from '../shared/code-syntax.ts';
import {nativeRenderSegments} from '../client/native-syntax.ts';
import vm from 'node:vm';
import {buildSync} from 'esbuild';
const fixtures:Record<string,[string,string]>={
  go:['main.go','func main() { return }'],javascript:['main.mjs','const value = "hello";'],typescript:['main.ts','type Name = string;'],jsx:['main.jsx','const view = <Button />;'],tsx:['main.tsx','const view = <Button />;'],python:['main.py','def name():\n    return "value"'],java:['Main.java','public class Main {}'],kotlin:['main.kt','val name = "hello"'],swift:['main.swift','let name = "hello"'],c:['main.c','int main() { return 0; }'],cpp:['main.cpp','int main() { return 0; }'],csharp:['main.cs','public class Name {}'],rust:['main.rs','fn main() { let value = 1; }'],bash:['.env.local','NAME="hello"'],sql:['main.sql','SELECT * FROM users;'],json:['main.json','{"value": true}'],json5:['main.jsonc','// comment\n{"value": true}'],yaml:['main.yaml','value: true'],toml:['main.toml','value = true'],ini:['main.ini','[section]\nvalue=true'],properties:['main.properties','value=hello'],markup:['main.svg','<svg width="24"></svg>'],css:['main.css','body { color: red; }'],scss:['main.scss','$color: red; body { color: $color; }'],less:['main.less','@color: red; body { color: @color; }'],markdown:['main.md','# Heading\n\n**bold**'],makefile:['Makefile','all:\n\techo hello'],docker:['Dockerfile','FROM node:22\nRUN echo hello'],
};
test('every advertised language executes in the actual isolated parser Worker',async()=>{
  const syntax=new SyntaxService();try{
    assert.deepEqual(new Set(Object.keys(fixtures)),new Set(syntaxLanguages));
    for(const [language,[path,source]]of Object.entries(fixtures)){
      assert.equal(languageForPath(path),language,path);const result=await syntax.parse('fixture',path,source,language);
      assert.equal(result.state,'ready',language+': '+result.reason);assert.deepEqual(result.lines.map(line=>line.code),source.split('\n'));
      assert.ok(result.lines.some(line=>line.spans.length),language);
      for(const line of result.lines)assert.equal(nativeRenderSegments(line.code,line.spans).map(span=>line.code.slice(span.start,span.end)).join(''),line.code);
      assert.equal(syntax.lookup('fixture',path,language),result);assert.equal(syntax.lookup('different-owner',path,language),undefined);
    }
    assert.equal(languageForPath('notes.unknown'),'plain');
    assert.equal(languageForPath('constructor'),'plain');
  }finally{await syntax.close();}
});
test('nested grammars retain attributes and embedded script colors, with bounded Markdown fallback',async()=>{
  const syntax=new SyntaxService();try{
    const source='<div title="sample"><script>const answer = 42;</script></div>';
    const result=await syntax.parse('fixture','nested',source,'markup'),line=result.lines[0];
    const kindAt=(needle:string)=>line.spans.find(span=>span.start<=source.indexOf(needle)&&span.end>source.indexOf(needle))?.kind;
    assert.equal(kindAt('title'),'attribute');assert.equal(kindAt('sample'),'string');assert.equal(kindAt('const'),'keyword');assert.equal(kindAt('42'),'number');
    const markdown=await syntax.parse('fixture','budget','```text\n'+'line\n'.repeat(1300)+'```','markdown',true);
    assert.equal(markdown.reason,'markdown_preview_limit');assert.ok(markdown.lines.length>1200);assert.equal(markdown.markdown,undefined);
    assert.equal((await syntax.parse('fixture','next','const answer = 42;','typescript')).state,'ready');
  }finally{await syntax.close();}
});
test('cross-line context, Unicode and inline diff overlays preserve the complete source',async()=>{
  const syntax=new SyntaxService();try{
    for(const [language,text,kind]of [['go','/* first\r\nbody */\r\nfunc main() {}','comment'],['python','"""first\nbody"""\nprint(1)','string'],['typescript','const value = `first\nbody ${name}`;','string']] as const){
      const result=await syntax.parse('fixture',language,text,language),line=result.lines[1];assert.ok(line.spans.some(s=>s.kind===kind),language);
    }
    const source='\tconst 名称 = "hello😀";',line=(await syntax.parse('fixture','unicode',source,'typescript')).lines[0];
    const start=source.indexOf('hello'),spans=nativeRenderSegments(source,line.spans,[start,start+5]);
    assert.equal(spans.map(s=>source.slice(s.start,s.end)).join(''),source);assert.ok(spans.some(s=>s.changed&&s.kind==='string'));
    const diff={protocol:1,patchDigest:'p',state:'ready' as const,left:{'1':line},right:{'1':line}};
    assert.equal(diffLineSyntax(diff,'p',source,{oldLine:1,newLine:1,kind:'context'}),line.spans);
    assert.equal(diffLineSyntax(diff,'p','different',{oldLine:1,newLine:1,kind:'context'}),null);
    assert.equal(diffLineSyntax(diff,'later',source,{oldLine:1,newLine:1,kind:'context'}),undefined);
  }finally{await syntax.close();}
});
test('Markdown is structured safe data and fences use the same syntax parser',async()=>{
  const syntax=new SyntaxService();try{
    const result=await syntax.parse('fixture','markdown','# Title\n\n**bold** after\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n[bad](javascript:alert(1))\n\n<script>alert(1)</script>\n\n```ini\n[section]\nvalue=true\n```','markdown',true);
    assert.equal(result.state,'ready');assert.ok(result.markdown?.some(node=>node.type==='table_open'));
    assert.ok(!JSON.stringify(result.markdown).includes('"type":"html_block"'));
    assert.ok(result.markdown?.find(node=>node.type==='fence')?.lines?.some(line=>line.spans.length));
  }finally{await syntax.close();}
});
test('retirement and cancellation stop owned parsing without poisoning subsequent views',async()=>{
  const syntax=new SyntaxService();try{
    const before=syntax.parse('old','old','/* '.repeat(10000),'go');syntax.retire('old');assert.equal((await before).state,'plain');
    const abort=new AbortController(),pending=syntax.parse('new','cancel','const value = 1;','typescript',false,abort.signal);abort.abort();assert.equal((await pending).state,'plain');
    assert.equal((await syntax.parse('new','next','const value = 1;','typescript')).state,'ready');
    syntax.retire('new');assert.equal(syntax.lookup('new','next','typescript'),undefined);
    assert.equal((await syntax.parse('new','huge','x'.repeat(2*1024*1024+1),'go')).reason,'large_file');
  }finally{await syntax.close();}
});
test('legacy web Diff keeps inline backgrounds while coloring the complete line',()=>{
  const bundle=buildSync({entryPoints:[new URL('../client/syntax-web.tsx',import.meta.url).pathname],bundle:true,format:'cjs',platform:'neutral',external:['react','react/jsx-runtime','react-native'],jsx:'automatic',write:false});
  const element=(type:any,props:any):any=>typeof type==='function'?type(props):({type,props}),module={exports:{} as any};
  vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require(name:string){if(name==='react')return {memo:(f:any)=>f};if(name==='react/jsx-runtime')return {jsx:element,jsxs:element};if(name==='react-native')return {Platform:{OS:'web'},Text:'Text'};throw Error(name);}});
  const code='const message = "old body";',start=code.indexOf('old'),rendered=module.exports.HighlightedCode({code,path:'file.ts',inlineChange:[start,start+3],changeBackground:'#abcdef',theme:{colors:{surface0:'#111111',foreground:'#eeeeee',foregroundMuted:'#999999'}}});
  const pieces:any[]=[];function collect(value:any){if(value?.props?.children!==undefined){const children=value.props.children;if(typeof children==='string')pieces.push({text:children,style:value.props.style});else for(const child of Array.isArray(children)?children:[children])collect(child);}}collect(rendered);
  assert.equal(pieces.map(p=>p.text).join(''),code);assert.equal(pieces.filter(p=>p.style?.backgroundColor==='#abcdef').map(p=>p.text).join(''),'old');assert.ok(new Set(pieces.map(p=>p.style?.color)).size>1);
});
