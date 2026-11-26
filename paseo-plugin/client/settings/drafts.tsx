import { createContext, useContext, useEffect, useRef, useState } from 'react';
type Draft = { save():Promise<void>; discard():void };
export const SettingsDrafts = createContext<{register(id:string,value:Draft|null):void;guard(action:()=>void):void}>({register(){},guard(action){action();}});
// Keep unsaved edits when the host replaces a contextual panel after a focus change.
// Secrets stay in this process only; persistence belongs to the server settings store.
const retained = new Map<string, object>();
export function useSettingsDraftRegistration(id:string,dirty:boolean,save:()=>Promise<void>,discard:()=>void) {
  const context=useContext(SettingsDrafts),current=useRef({save,discard});current.current={save,discard};
  useEffect(()=>{context.register(id,dirty?{save:()=>current.current.save(),discard:()=>current.current.discard()}:null);return()=>context.register(id,null);},[context,id,dirty]);
}
export function useSettingsForm<T extends object>(id:string,base:T|undefined,save:(patch:Partial<T>)=>Promise<unknown>) {
  const context=useContext(SettingsDrafts),[patch,setPatch]=useState<Partial<T>>(()=>retained.get(id)||{}),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const current=useRef({patch,save});current.current={patch,save};
  const dirty=Object.keys(patch).length>0;
  const discard=()=>{retained.delete(id);setPatch({});setError('');};
  const commit=async()=>{setSaving(true);setError('');try{await current.current.save(current.current.patch);discard();}catch(e){setError(e instanceof Error?e.message:String(e));throw e;}finally{setSaving(false);}};
  useEffect(()=>{context.register(id,dirty?{save:commit,discard}:null);return()=>context.register(id,null);},[context,id,dirty]);
  function change<K extends keyof T>(key:K,value:T[K]) {setPatch(previous=>{const next={...previous,[key]:value};if(base&&JSON.stringify(base[key])===JSON.stringify(value))delete next[key];retained.set(id,next);return next;});}
  return {value:{...base,...patch} as T,patch,change,dirty,saving,error,discard,save:commit,guard:context.guard,report:(e:unknown)=>setError(e instanceof Error?e.message:String(e))};
}
