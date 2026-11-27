import type {PaseoApi} from '@getpaseo/client';
export type ConversationHead={epoch:string;seq:number};

/** Timeline revisions include tools and runtime events. Only new public
 * messages invalidate a title made from public conversation material. */
export async function samePublicConversation(api:PaseoApi,agentId:string,expected:ConversationHead|undefined,current:ConversationHead,assertCurrent:()=>void){
 if(!expected||expected.epoch!==current.epoch||current.seq<expected.seq)return{same:false,head:current};
 if(current.seq===expected.seq)return{same:true,head:current};
 let cursor=expected.seq;
 for(let n=0;n<8;n++){
  assertCurrent();const page=await api.agents.ref(agentId).timeline.refetch({limit:100,direction:'after',cursor:{epoch:current.epoch,seq:cursor}});assertCurrent();
  if(page.error||page.staleCursor||page.epoch!==current.epoch)return{same:false,head:current};
  if(page.entries.some(e=>e.item.type==='user_message'||e.item.type==='assistant_message'&&!!e.item.text))return{same:false,head:current};
  const last=page.entries.at(-1)?.seqEnd;if(!last||last<=cursor)return{same:false,head:current};
  if(last>=current.seq)return{same:true,head:{epoch:current.epoch,seq:last}};
  if(!page.hasNewer)return{same:false,head:current};cursor=last;
 }
 return{same:false,head:current};
}
