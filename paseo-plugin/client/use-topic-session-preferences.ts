import {useCallback,useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import type {TopicsClient} from './use-topics';
import type {TopicSessionPreferences} from '../shared/extensions/project-communications/topics';

/** The host owns persistence, so choices survive reloads and follow this project across clients. */
export function useTopicSessionPreferences(client:TopicsClient){
  const cache=useQueryClient(),scope=client.scopeKey,key=['archive-topic-session-preferences',scope];
  const saved=useQuery({queryKey:key,queryFn:()=>client.call<TopicSessionPreferences>({action:'preferences'}),
    enabled:client.active,retry:false,staleTime:Infinity,refetchOnWindowFocus:false});
  const [draft,setDraft]=useState<{scope:string;value:TopicSessionPreferences}>();
  const [failure,setFailure]=useState<{scope:string;message:string}>(),queue=useRef(Promise.resolve());
  const value=draft?.scope===scope?draft.value:saved.data||{destination:'existing' as const};
  const current=useRef(value);current.current=value;
  const update=useCallback((patch:Partial<TopicSessionPreferences>)=>{
    const next={...current.current,...patch};current.current=next;setDraft({scope,value:next});
    queue.current=queue.current.then(async()=>{
      const result=await client.call<TopicSessionPreferences>({action:'preferences',value:next});
      cache.setQueryData(['archive-topic-session-preferences',scope],result);setFailure(current=>current?.scope===scope?undefined:current);
    }).catch(()=>{setFailure({scope,message:'本次选择暂未保存'});});
  },[client.call,scope,cache]);
  return {value,update,ready:saved.isSuccess,error:(failure?.scope===scope?failure.message:'')||saved.error?.message||'',
    retry:()=>{if(saved.isSuccess)update({});else void saved.refetch();}};
}
