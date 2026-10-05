import {useEffect,useRef,useState} from 'react';
import {Platform} from 'react-native';
import {languageForPath,type DiffDisplayRow} from './model';
import {NATIVE_SYNTAX_LIMITS,nativeLanguage,type SyntaxSpan} from './native-syntax';
import {reportNativeDiagnostic} from './native-diagnostics';
import type {createNativeSyntaxEngine} from './native-syntax-engine';
type Engine=ReturnType<typeof createNativeSyntaxEngine>;
/** No per-line effects. Work is scheduled after a paint, in visible-first batches. */
export function useNativeSyntax(rows:DiffDisplayRow[],path:string,foreground:boolean,visible:readonly number[]){
 const engine=useRef<Engine|null>(null),failed=useRef(false);
 const [,publish]=useState(0);
 const language=nativeLanguage(languageForPath(path));
 useEffect(()=>{
  if(Platform.OS==='web'||!foreground||!language||!visible.length||failed.current)return;
  let live=true,stage='load',reported=false;
  const fail=(error:unknown)=>{if(!live||failed.current)return;failed.current=true;reportNativeDiagnostic('native-syntax-failed',{phase:'syntax',reason:'optional_highlighter_unavailable',errorType:error instanceof Error?error.name:'unknown',stage,message:error instanceof Error?error.message.slice(0,160):'unknown'});};
  void import('./native-syntax-engine').then(module=>{
   if(!live)return;
   stage='initialize';
   const active=module.createNativeSyntaxEngine({publish:()=>{if(live){publish(value=>(value+1)%1e9);if(!reported&&codes.some(code=>active.read(code)?.some(span=>span.kind!=='plain'))){reported=true;reportNativeDiagnostic('native-syntax-ready',{revision:'factory-v2',stage:'colored-ranges-published'});}}},onError:error=>{stage='scan';fail(error);},
    schedule:fn=>{const ticket:{frame?:number;timer?:ReturnType<typeof setTimeout>}={};
     const next=()=>{ticket.timer=setTimeout(fn,0);};
     if(typeof requestAnimationFrame==='function')ticket.frame=requestAnimationFrame(next);else ticket.timer=setTimeout(fn,16);
     return ticket;},
    cancel:handle=>{const ticket=handle as {frame?:number;timer?:ReturnType<typeof setTimeout>};if(ticket.frame!==undefined&&typeof cancelAnimationFrame==='function')cancelAnimationFrame(ticket.frame);if(ticket.timer!==undefined)clearTimeout(ticket.timer);},
   });
   engine.current=active;
   const bounded=visible.slice(0,NATIVE_SYNTAX_LIMITS.cacheLines);
   const indexes=new Set(bounded);
   const first=Math.min(...bounded),last=Math.max(...bounded);
   for(let distance=1;distance<=NATIVE_SYNTAX_LIMITS.contextRows;distance++){if(first-distance>=0)indexes.add(first-distance);if(last+distance<rows.length)indexes.add(last+distance);}
   const codes:string[]=[];
   for(const index of indexes){const row=rows[index];if(row?.kind==='unified')codes.push(row.line.content);else if(row?.kind==='split'){if(row.left)codes.push(row.left.content);if(row.right)codes.push(row.right.content);}}
   stage='schedule';
   active.update(language,codes);publish(value=>(value+1)%1e9);
  }).catch(fail);
  return()=>{live=false;engine.current?.stop();};
 },[rows,path,foreground,visible,language]);
 return (code:string):readonly SyntaxSpan[]|null|undefined=>failed.current?undefined:engine.current?.read(code);
}
