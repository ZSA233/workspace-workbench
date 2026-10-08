import {useCallback,useEffect,useRef,useState} from 'react';
const EMPTY:Record<string,number>={};
/** Keep individual layout events out of React; publish one batch per frame. */
export function useDiffMeasurements(generation:object,paused=false){
 const alive=useRef(true);
 const latest=useRef(generation);latest.current=generation;
 const pause=useRef(paused);pause.current=paused;
 const [state,setState]=useState({generation,values:EMPTY});
 const pending=useRef<Record<string,number>>({}),frame=useRef<ReturnType<typeof setTimeout>|number|undefined>(undefined);
 const values=state.generation===generation?state.values:EMPTY,valuesRef=useRef(values);valuesRef.current=values;
 const queuedGeneration=useRef(generation);
 if(queuedGeneration.current!==generation){pending.current={};queuedGeneration.current=generation;}
 const flush=useCallback(()=>{
  frame.current=undefined;if(pause.current||!alive.current)return;
  const batch=pending.current;pending.current={};if(!Object.keys(batch).length)return;
  const identity=latest.current;setState(previous=>({generation:identity,values:{...(previous.generation===identity?previous.values:EMPTY),...batch}}));
 },[]);
 const measure=useCallback((key:string,height:number)=>{
  if(!alive.current||latest.current!==generation||!Number.isFinite(height)||height<=0||valuesRef.current[key]===height||pending.current[key]===height)return;
  pending.current[key]=height;if(frame.current===undefined&&!pause.current)frame.current=typeof requestAnimationFrame==='function'?requestAnimationFrame(flush):setTimeout(flush,16);
 },[generation,flush]);
 useEffect(()=>{if(!paused)flush();},[paused,flush]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;if(frame.current!==undefined){if(typeof cancelAnimationFrame==='function')cancelAnimationFrame(frame.current as number);else clearTimeout(frame.current);}frame.current=undefined;};},[]);
 return {values,measure};
}
