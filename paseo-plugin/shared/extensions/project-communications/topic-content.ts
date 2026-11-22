import {z} from 'zod';
import type {ArchiveMessage} from './topics.ts';
import {messageText} from './topic-presentation.ts';

export const TOPIC_TEXT_LIMIT=120000;
export const topicTemplateSchema=z.object({id:z.string().min(1).max(80),name:z.string().trim().min(1).max(40),body:z.string().max(12000)});
export type TopicTemplate=z.infer<typeof topicTemplateSchema>;
export const topicMaterialSettingsSchema=z.object({layout:z.enum(['auto','text','conversation']).default('auto'),
  identity:z.enum(['alias','name']).default('alias'),presetId:z.string().max(80).default('forward'),presets:z.array(topicTemplateSchema).max(8).default([])});
export type TopicMaterialSettings=z.infer<typeof topicMaterialSettingsSchema>;
export const topicContentOptionsSchema=z.object({layout:z.enum(['auto','text','conversation']).default('auto'),identity:z.enum(['alias','name']).default('alias'),
  timeZone:z.string().min(1).max(100).default('Asia/Shanghai'),template:z.string().max(12000).default('{{note}}\n\n{{materials}}'),
  aliases:z.array(z.object({key:z.string().min(1).max(4096),label:z.string().regex(/^参与者 [A-Z]+$/).max(40)})).max(512).optional()});
export type TopicContentOptions=z.infer<typeof topicContentOptionsSchema>;
export const defaultTopicMaterialSettings:TopicMaterialSettings={layout:'auto',identity:'alias',presetId:'forward',presets:[]};
export const topicBuiltInTemplates:TopicTemplate[]=[{id:'forward',name:'普通转发',body:'{{note}}\n\n{{materials}}'},
  {id:'discussion',name:'对话整理',body:'{{note}}\n\n以下是我选择的对话片段。请结合发言顺序、说话者和相互回应来理解，不要把不同人的说法混为一谈。\n\n{{materials}}'}];
export function topicTemplateError(body:string){
  if(body.length>12000)return '模板内容过长';
  if(body.split('{{materials}}').length!==2)return '请保留一处「所选材料」';
  if(body.split('{{note}}').length!==2)return '请保留一处「本次说明」';
  return '';
}
export function topicContentOptions(settings:TopicMaterialSettings,timeZone:string):TopicContentOptions{
  const preset=[...topicBuiltInTemplates,...settings.presets].find(item=>item.id===settings.presetId)||topicBuiltInTemplates[0];
  return {layout:settings.layout,identity:settings.identity,timeZone,template:preset.body};
}

export type TopicContentEntry={topicId:string;message:ArchiveMessage;editedText?:string;includeText?:boolean;assetIds?:string[]};
export type TopicContentPerson={key:string;name:string;label:string;scope:string;scopes:string[];sourceId?:string;names:string[]};
export type TopicContentAlias=Pick<TopicContentPerson,'key'|'label'>;
export type TopicContentRow=TopicContentEntry&{key:string;text:string;speaker:string;time:string;replyTo?:string;edited:boolean};
const unknownNames=new Set(['未知参与者','未知作者','未知成员','unknown']);
const sender=(message:ArchiveMessage)=>{const name=typeof message.sender==='string'?message.sender:message.sender?.displayName||message.sender?.name;return name?.trim()&&!unknownNames.has(name)?name:'未知参与者';};
const scope=(message:ArchiveMessage)=>JSON.stringify([message.sourceId,message.sourceAccountId||'',message.channelId]);
const senderId=(message:ArchiveMessage)=>message.senderId||(typeof message.sender==='object'?message.sender.id:'');
export const topicMessageKey=(message:ArchiveMessage)=>JSON.stringify([message.sourceId,message.sourceAccountId||'',message.channelId,message.id,message.version]);
function personKey(message:ArchiveMessage){const id=senderId(message),name=sender(message);return id?JSON.stringify([message.sourceId,message.sourceAccountId||'',id]):JSON.stringify([scope(message),name==='未知参与者'?message.id:name]);}
function letters(index:number){let value=index+1,result='';while(value){value--;result=String.fromCharCode(65+value%26)+result;value=Math.floor(value/26);}return result;}
export function chronologicalMessages<T extends {message:ArchiveMessage}>(entries:T[]):T[]{
  return entries.map((entry,index)=>({entry,index})).sort((a,b)=>{
    const left=a.entry.message,right=b.entry.message,knownLeft=left.timestampKnown!==false&&Number.isFinite(left.createdAt),knownRight=right.timestampKnown!==false&&Number.isFinite(right.createdAt);
    if(knownLeft!==knownRight)return knownLeft?-1:1;
    if(knownLeft&&left.createdAt!==right.createdAt)return left.createdAt-right.createdAt;
    if(typeof left.ingestSequence==='number'&&typeof right.ingestSequence==='number'&&left.ingestSequence!==right.ingestSequence)return left.ingestSequence-right.ingestSequence;
    return a.index-b.index;
  }).map(item=>item.entry);
}
function dateFormatter(timeZone:string){
  try{return new Intl.DateTimeFormat('sv-SE',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});}
  catch{throw Error('topic_content_timezone_invalid');}
}
function names(name:string){
  const result=[name],open=name.indexOf('(');
  if(open>0&&name.endsWith(')')&&name.slice(open+1,-1)===name.slice(0,open))result.push(name.slice(0,open));
  return result.filter(value=>value&&!unknownNames.has(value));
}
/** A batch keeps its chosen aliases when earlier context is added later. */
export function topicContentPeople(entries:TopicContentEntry[],saved:TopicContentAlias[]=[]){
  const people:TopicContentPerson[]=[],personByKey=new Map<string,TopicContentPerson>(),labels=new Map<string,string>(),used=new Set<string>();
  for(const item of saved){if(labels.has(item.key)||used.has(item.label))throw Error('topic_content_alias_invalid');labels.set(item.key,item.label);used.add(item.label);}
  let ordinal=0;
  const add=(key:string,name:string,message:ArchiveMessage,sourceId?:string)=>{
    let person=personByKey.get(key);
    if(!person){
      let label=labels.get(key);if(!label){while(used.has('参与者 '+letters(ordinal)))ordinal++;label='参与者 '+letters(ordinal++);used.add(label);}
      person={key,name,names:[name],label,scope:scope(message),scopes:[scope(message)],sourceId};people.push(person);personByKey.set(key,person);
    }else {if(!person.names.includes(name))person.names.push(name);if(!person.scopes.includes(scope(message)))person.scopes.push(scope(message));}
    return person;
  };
  const sorted=chronologicalMessages(entries);
  for(const entry of sorted)add(personKey(entry.message),sender(entry.message),entry.message,senderId(entry.message));
  for(const {message}of sorted)for(const mention of message.mentions||[]){
    if(typeof mention!=='object'||!mention)continue;
    const id=mention.id||mention.userId||mention.senderId,name=mention.displayName||mention.name;
    if(id&&name)add(JSON.stringify([message.sourceId,message.sourceAccountId||'',id]),name,message,id);
  }
  return people;
}
function word(char:string){return Boolean(char)&&(/[a-zA-Z0-9_]/.test(char)||char.charCodeAt(0)>127&&char.trim()!=='');}
function asciiWord(char:string){return Boolean(char)&&/[a-zA-Z0-9_]/.test(char);}
const punctuation=new Set([' ', '\n','\r','\t','，','。','！','？','：','；',',','!','?',':',';','（','）','(',')','[',']','{','}','<','>']);

/** Identity comes from archived authors/mention metadata. Unknown names are
 * retained, never guessed or removed with an @-token regular expression. */
function replaceIdentities(text:string,message:ArchiveMessage,people:TopicContentPerson[],unresolved:Set<string>){
  const byFirst=new Map<string,Array<{name:string;people:TopicContentPerson[]}>>(),byName=new Map<string,TopicContentPerson[]>();
  for(const person of people)for(const name of person.names.flatMap(names)){
    const list=byName.get(name)||[];if(!list.some(item=>item.key===person.key))list.push(person);byName.set(name,list);
  }
  for(const [name,list]of byName){const bucket=byFirst.get(name[0])||[];bucket.push({name,people:list});byFirst.set(name[0],bucket);}
  for(const bucket of byFirst.values())bucket.sort((a,b)=>b.name.length-a.name.length);
  let result='',index=0;
  while(index<text.length){
    if(text.startsWith('https://',index)||text.startsWith('http://',index)||text.startsWith('mailto:',index)){
      let end=index;while(end<text.length&&![' ','\n','\r','\t','<','>','"'].includes(text[end]))end++;
      result+=text.slice(index,end);index=end;continue;
    }
    if(text[index]==='`'){
      let end=index;while(text[end]==='`')end++;const delimiter=text.slice(index,end),close=text.indexOf(delimiter,end);
      const through=close<0?text.length:close+delimiter.length;result+=text.slice(index,through);index=through;continue;
    }
    if(index===0||punctuation.has(text[index-1])){
      let end=index;while(end<text.length&&!punctuation.has(text[end]))end++;
      const token=text.slice(index,end);
      if(token.startsWith('http://')||token.startsWith('https://')||token.includes('@')&&(!token.startsWith('@')||token.includes('/')||token.includes('.'))){
        result+=token;index=end;continue;
      }
    }
    const at=text[index]==='@',start=at?index+1:index;
    // Do not rewrite emails, scoped packages, URLs or inline code.
    if(at&&asciiWord(text[index-1]||'')){result+='@';index++;continue;}
    let replacement:TopicContentPerson|undefined,length=0;
    for(const candidate of byFirst.get(text[start])||[]){
      if(!text.startsWith(candidate.name,start))continue;
      const end=start+candidate.name.length,next=text[end]||'',previous=text[index-1]||'';
      if(next==='/'||next==='.'||next==='\\'||(!at&&asciiWord(candidate.name[0])&&asciiWord(previous))||asciiWord(candidate.name.at(-1)!)&&asciiWord(next))continue;
      // A one-character name is too ambiguous inside natural-language text.
      if(!at&&Array.from(candidate.name).length<2)continue;
      const local=candidate.people.filter(person=>person.scopes.includes(scope(message)));
      const matches=local.length?local:candidate.people;
      if(matches.length!==1){if(at)unresolved.add(candidate.name);continue;}
      replacement=matches[0];length=candidate.name.length;
      const repeated='('+candidate.name+')';if(text.startsWith(repeated,end))length+=repeated.length;
      break;
    }
    if(replacement){result+=(at?'@':'')+replacement.label;index=start+length;continue;}
    if(at&&(!word(text[index-1]||'')||text[index-1]?.charCodeAt(0)>127)){
      let end=start;while(end<text.length&&!punctuation.has(text[end])&&text[end]!=='@')end++;
      const value=text.slice(start,end);if(value&&value.length<=40&&!value.includes('/')&&!value.includes('.')&&!value.includes('\\'))unresolved.add(value);
    }
    result+=text[index++];
  }
  return result;
}

export function prepareTopicContent(entries:TopicContentEntry[],input:Partial<TopicContentOptions>={},note='',extra:string[]=[]){
  const options=topicContentOptionsSchema.parse(input),format=dateFormatter(options.timeZone),error=topicTemplateError(options.template);
  if(error)throw Error('topic_content_template_invalid: '+error);
  const sorted=chronologicalMessages(entries),unique=new Map<string,TopicContentEntry>();
  for(const entry of sorted){
    const key=topicMessageKey(entry.message),previous=unique.get(key);
    if(previous&&entry.editedText!==undefined&&previous.editedText!==undefined&&entry.editedText!==previous.editedText)throw Error('topic_message_edit_conflict');
    unique.set(key,{...entry,topicId:previous?.topicId||entry.topicId,message:previous?.message||entry.message,
      editedText:entry.editedText===undefined?previous?.editedText:entry.editedText,
      includeText:entry.includeText!==false||Boolean(previous&&previous.includeText!==false),
      assetIds:[...new Set([...(previous?.assetIds||[]),...(entry.assetIds||[])])]});
  }
  const values=[...unique.values()],people=topicContentPeople(values,options.aliases),personByKey=new Map(people.map(person=>[person.key,person]));
  const speakers=new Set(values.filter(entry=>entry.includeText!==false||entry.assetIds?.length).map(entry=>personKey(entry.message)));
  const conversation=options.layout==='conversation'||options.layout==='auto'&&speakers.size>1,unresolved=new Set<string>();
  const selectedById=new Map(values.flatMap(entry=>[entry.message.id,entry.message.archiveId,entry.message.externalMessageId].filter(Boolean).map(id=>[JSON.stringify([scope(entry.message),id]),entry] as const)));
  const rows:TopicContentRow[]=values.map(entry=>{
    const person=personByKey.get(personKey(entry.message))!;
    const text=entry.includeText===false?'':entry.editedText===undefined?messageText(entry.message):entry.editedText;
    const quote=entry.message.quote&&typeof entry.message.quote==='object'?entry.message.quote as Record<string,unknown>:{};
    const reply=entry.message.replyTo||quote.messageId||quote.archiveId;
    const referenced=typeof reply==='string'?selectedById.get(JSON.stringify([scope(entry.message),reply])):undefined;
    const target=referenced?personByKey.get(personKey(referenced.message)):undefined;
    return {...entry,key:topicMessageKey(entry.message),edited:entry.editedText!==undefined,
      speaker:options.identity==='alias'?person.label:person.name,
      time:entry.message.timestampKnown===false||!Number.isFinite(entry.message.createdAt)?'时间未提供':format.format(entry.message.createdAt),
      ...(target?{replyTo:options.identity==='alias'?target.label:target.name}:{}),
      text:options.identity==='alias'?replaceIdentities(text,entry.message,people,unresolved):text};
  });
  const materials=[...rows.filter(row=>row.text.trim()||conversation&&row.assetIds?.length).map(row=>conversation
    ?row.speaker+(row.edited?'（已编辑）':'')+' · '+row.time+(row.replyTo?' · 回复 '+row.replyTo:'')+(row.text?'\n'+row.text:''):row.text),...extra.filter(Boolean)].join('\n\n');
  const noteScope={sourceId:'',channelId:'',sourceAccountId:''} as ArchiveMessage;
  const finalNote=options.identity==='alias'?replaceIdentities(note,noteScope,people,unresolved):note;
  const text=options.template.replace(/\{\{(note|materials)\}\}/g,(_match,key)=>key==='note'?finalNote:materials).replace(/^\n+|\n+$/g,'');
  if(text.length>TOPIC_TEXT_LIMIT)throw Error('topic_material_text_limit');
  return {text,rows,people,conversation,unresolved:[...unresolved],options,noteText:finalNote};
}
