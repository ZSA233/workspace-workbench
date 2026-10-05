import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Component-level native adapter test, not a native device or renderer test.
function adapter(colors:Record<string,string>){
 const source=readFileSync(new URL('../client/native-components.tsx',import.meta.url),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const component=()=>null;
 const native={Platform:{OS:'android'},View:component,Text:component,Modal:component,TextInput:component,ScrollView:component,FlatList:component};
 const exports:Record<string,any>={};
 vm.runInNewContext(code,{exports,require:(name:string)=>{
  if(name==='react-native')return native;
  if(name==='react')return {createElement:(type:unknown,props:unknown,...children:unknown[])=>({type,props,children})};
  if(name==='./theme-context')return {useWorkbenchThemeColors:()=>colors};
  if(name==='./native-diagnostics')return {reportNativeDiagnostic:()=>{}};
  if(name==='./geometric-icon')return {GeometricIcon:component};
  if(name==='@getpaseo/plugin/client/react-native')return {};
  throw Error('Unexpected native import '+name);
 }});
 return exports;
}
for(const [theme,colors] of Object.entries({dark:{surface1:'#202124',foreground:'#f1f3f4',foregroundMuted:'#b4bac2'},light:{surface1:'#ffffff',foreground:'#202124',foregroundMuted:'#555555'}})){
 test(`${theme}: native input and modal use theme colors without host exports or DOM`,()=>{
  const ui=adapter(colors),input=ui.TextInput({value:'sample'});
  assert.equal(input.props.style[0].color,colors.foreground);
  assert.equal(input.props.placeholderTextColor,colors.foregroundMuted);
  const overridden=ui.TextInput({style:{color:'red'},placeholderTextColor:'blue'});
  assert.equal(overridden.props.style[1].color,'red');assert.equal(overridden.props.placeholderTextColor,'blue');
  const wrapper=ui.Modal({open:true,title:'Session',onOpenChange:()=>{},children:'Content'}),modal=wrapper.type(wrapper.props);
  const card=modal.children[0].children[0];
  assert.equal(card.props.style.backgroundColor,colors.surface1);
  assert.equal(card.children[0].props.style.color,colors.foreground);
 });
}
