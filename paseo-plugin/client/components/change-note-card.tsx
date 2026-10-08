import {observerAccent} from '../theme';
import {noteNeedsConfirmation} from '../change-notes-model';
import {useState,useRef,useEffect} from 'react';
import {Pressable,Text,View} from 'react-native';
import {TextInput,copyText,Icon} from '../native-components';
import {IconButton} from './icon-button';
import {useWorkbenchLocale} from '../i18n';
import type {ChangeNote,NotesResult,NoteManagementInput,NoteTextEdit,NoteUserEvent} from '../../shared/change-notes';
import type {NoteDraft} from '../note-popover-model';
import type {PluginWorkspacePanelProps} from '@getpaseo/plugin/client';
type Props={note:ChangeNote;data:NotesResult;current:boolean;theme:PluginWorkspacePanelProps['theme'];draft:NoteDraft;
 onDraftChange(value:NoteDraft,expected?:NoteDraft):void;onExpanded(value:boolean):void;onOriginal?:()=>Promise<string>;onClose():void;
 onLatest?:()=>Promise<void>;
 onManage(edit:NoteManagementInput):Promise<void>;
 onFeedback(action:'read'|'question'|'confirm',text?:string):Promise<void>;onAnchor?(index:number):void};
/** The default view is intentionally small; the full explanation is preserved in details. */
export function ChangeNoteCard({note,data,current,theme,draft,onDraftChange,onExpanded,onClose,onFeedback,onAnchor,onOriginal,onManage,onLatest}:Props){
 const zh=useWorkbenchLocale()==='zh-CN',t=(a:string,b:string)=>zh?a:b,c=theme.colors,accent=observerAccent(theme);
 const draftRef=useRef(draft);
 function publishDraft(value:NoteDraft,expected?:NoteDraft){if(expected&&JSON.stringify(draftRef.current)!==JSON.stringify(expected))return;draftRef.current=value;onDraftChange(value,expected);}
 const mounted=useRef(true);useEffect(()=>{onExpanded(false);mounted.current=true;return()=>{mounted.current=false;};},[]);
 const [mode,setMode]=useState<'brief'|'details'|'more'|'question'|'confirm'|'copy'|'edit'|'withdraw'|'question-edit'|'question-delete'>('brief');
 const [original,setOriginal]=useState(''),[originalPage,setOriginalPage]=useState(0),[input,setInput]=useState(draft.text),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [management,setManagement]=useState<NoteManagementInput|undefined>(draft.management);
 const n=note.content,events=data.feedback.filter(e=>e.id===note.id&&e.revision===note.revision&&!e.deleted),snapshot=data.snapshots[note.snapshotId];
 const normal={color:c.foreground,fontSize:13,lineHeight:20},muted={color:c.foregroundMuted,fontSize:12,lineHeight:18};
 function show(value:typeof mode){if(!mounted.current)return;setMode(value);onExpanded(value!=='brief');setError('');}
 function edit(kind:'question'|'confirm'){publishDraft({...draftRef.current,text:input,kind});show(kind);}
 async function save(action:'read'|'question'|'confirm'){
  const captured=draftRef.current;
  setBusy(true);setError('');try{await onFeedback(action,input);if(action!=='read'){publishDraft({...captured,text:'',kind:null},captured);if(mounted.current)setInput('');}show('brief');}catch(e){if(mounted.current)setError(String(e));}finally{if(mounted.current)setBusy(false);}
 }
 function setEdit(value:NoteManagementInput){setManagement(value);publishDraft({...draftRef.current,management:value});}
 function startEdit(){const {anchors,...content}=n;const next=management?.action==='edit'?management:{action:'edit' as const,content};setEdit(next);show('edit');}
 function startQuestion(event:NoteUserEvent,action:'question-edit'|'question-delete'){
  if(!event.eventId)return;
  const next=management?.action===action&&management.eventId===event.eventId?management:{action,eventId:event.eventId,expectedVersion:event.version||1,text:event.text};
  setEdit(next);show(action);
 }
 async function manage(){
  if(!management)return;const captured=draftRef.current;setBusy(true);setError('');
  try{await onManage(management);publishDraft({...captured,management:undefined},captured);if(mounted.current){setManagement(undefined);if(management.action==='withdraw')onClose();else show('brief');}}
  catch(e){if(mounted.current)setError(String(e));}finally{if(mounted.current)setBusy(false);}
 }
 const editField=(key:keyof Omit<NoteTextEdit,'basis'|'perspective'>,label:string,maxLength:number)=>management?.action==='edit'?<View key={key}><Text style={muted}>{label}</Text><TextInput accessibilityLabel={label} value={management.content[key]} editable={!busy} multiline={key!=='title'} maxLength={maxLength} onChangeText={value=>setEdit({...management,content:{...management.content,[key]:value}})} style={{...normal,borderWidth:1,borderColor:c.border,padding:6,minHeight:key==='title'?36:64}}/></View>:null;
 const button=(label:string,action:()=>void)=><Pressable accessibilityRole="button" disabled={busy} onPress={action} style={{paddingVertical:8,paddingHorizontal:4}}><Text style={{...normal,color:accent}}>{label}</Text></Pressable>;
 const full=[n.title,`Author: ${note.author}`,...(note.editedBy==='user'?['Edited by user']:[]),`Perspective: ${n.perspective}`,`Project: ${snapshot?.projectId||''}`,`Workspace: ${snapshot?.workspaceId||''}`,`Repository: ${snapshot?.repoPath||''}`,`Snapshot: ${note.snapshotId}`,`Range: ${snapshot?.left||'empty'} → ${snapshot?.right||'working snapshot'}`,`Reason: ${n.reason}`,`Behavior: ${n.behavior}`,`Requirement (${n.basis}): ${n.requirement}`,`Question: ${n.question}`,`Author-provided evidence: ${n.evidence}`,...n.anchors.map(a=>`${a.path} (${a.side}) ${a.start||''}-${a.end||''}`),...events.filter(e=>e.action!=='read').map(e=>`${e.action}: ${e.text}`)].join('\n');
 async function copy(){try{await copyText(full);show('brief');}catch{show('copy');setError(t('无法访问剪贴板，请手动复制。','Clipboard unavailable; copy the text manually.'));}}
 const pending=noteNeedsConfirmation(note,data);
 return <View testID="change-note-card" style={{padding:10,gap:6}}>
  <View style={{flexDirection:'row',alignItems:'center',gap:6}}>
   {mode==='brief'?<Icon name="MessageSquare" size={16} color={accent}/>:<IconButton label={t('返回简短说明','Back to summary')} icon="ArrowLeft" color={accent} onPress={()=>show('brief')}/>}
   <Text numberOfLines={mode==='brief'?1:undefined} style={{...normal,fontWeight:'600',flex:1}}>{n.title}</Text>
   <IconButton label={t('关闭说明','Close explanation')} icon="X" color={c.foregroundMuted} onPress={onClose}/>
  </View>
  {mode==='brief'?<>
   <Text testID="change-note-summary" numberOfLines={3} ellipsizeMode="tail" style={normal}>{n.reason}</Text>
   {!current||pending?<View style={{flexDirection:'row',alignItems:'center',gap:5,alignSelf:'flex-start',borderWidth:1,borderColor:c.statusWarning,borderRadius:4,paddingHorizontal:5,paddingVertical:1}}><Icon name="CircleAlert" size={12} color={c.statusWarning}/><Text style={{...muted,color:c.statusWarning}}>{!current?t('待更新','Needs update'):t('待确认','Needs confirmation')}</Text></View>:null}
   <View style={{flexDirection:'row',alignItems:'center',borderTopWidth:1,borderTopColor:c.border,paddingTop:3}}>
    {!note.historical?<IconButton label={t('提出疑问','Ask a question')} icon="MessageSquare" color={c.foregroundMuted} onPress={()=>edit('question')}/>:null}
    <IconButton label={t('说明操作','Explanation actions')} icon="Ellipsis" color={c.foregroundMuted} onPress={()=>show('more')}/>
    <View style={{flex:1}}/>{button(t('详情','Details'),()=>show('details'))}
   </View>
  </>:mode==='more'?<>
   {!note.historical?button(t('编辑说明','Edit explanation'),startEdit):null}{!note.historical?button(t('删除说明','Delete explanation'),()=>{setEdit({action:'withdraw'});show('withdraw');}):null}
   {!note.historical?button(t('已阅','Read'),()=>void save('read')):null}{button(t('复制说明与疑问','Copy explanation and questions'),()=>void copy())}{!note.historical?button(t('记录确认结果','Record confirmation'),()=>edit('confirm')):null}
  </>:mode==='edit'&&management?.action==='edit'?<>
   <Text style={muted}>{t('保留代码关联和原作者，保存为用户修订。','Keeps code locations and original author; saved as a user revision.')}</Text>
   {editField('title',t('标题','Title'),200)}{editField('reason',t('修改原因','Reason'),8000)}{editField('behavior',t('行为变化','Behavior change'),8000)}
   <Text style={muted}>{t('需求来源','Requirement basis')}</Text><View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>{(['requirement','autonomous','missing-context'] as const).map(value=><Pressable key={value} disabled={busy} accessibilityRole="radio" accessibilityState={{checked:management.content.basis===value}} onPress={()=>setEdit({...management,content:{...management.content,basis:value}})}><Text style={{...normal,color:management.content.basis===value?accent:c.foregroundMuted}}>{t(value==='requirement'?'需求依据':value==='autonomous'?'自主调整':'缺少上下文',value)}</Text></Pressable>)}</View>
   {editField('requirement',t('需求依据','Requirement'),8000)}{editField('question',t('待确认事项','Open question'),4000)}{editField('evidence',t('验证依据','Evidence'),8000)}
   {button(t('保存修改','Save changes'),()=>void manage())}
  </>:mode==='withdraw'?<>
   <Text style={normal}>{t(`删除此说明会移除全部 ${n.anchors.length} 处关联标记，保留历史记录。`,`Deleting this explanation removes all ${n.anchors.length} location markers and retains history.`)}</Text>
   {button(t('确认删除说明','Confirm delete explanation'),()=>void manage())}{button(t('取消','Cancel'),()=>show('more'))}
  </>:mode==='question-edit'&&management?.action==='question-edit'?<>
   <Text style={muted}>{t('修改疑问后重新标记为待确认，不自动发送。','Editing reopens confirmation; no message is sent.')}</Text>
   <TextInput accessibilityLabel={t('编辑疑问','Edit question')} multiline maxLength={4000} editable={!busy} value={management.text} onChangeText={text=>setEdit({...management,text})} style={{...normal,minHeight:80,padding:8,borderWidth:1,borderColor:c.border}}/>
   {button(t('保存疑问','Save question'),()=>void manage())}
  </>:mode==='question-delete'?<>
   <Text style={normal}>{t('删除这条疑问？说明内容保持不变，历史记录会保留。','Delete this question? The explanation and history are retained.')}</Text>
   {button(t('确认删除疑问','Confirm delete question'),()=>void manage())}{button(t('取消','Cancel'),()=>show('details'))}
  </>:mode==='question'||mode==='confirm'?<>
   <Text style={muted}>{mode==='question'?t('疑问仅保存在本地，不自动发送','Saved locally; no message is sent'):t('记录你的判断；已阅不代表认可','Record your decision; reading is not approval')}</Text>
   <TextInput testID="note-feedback-input" accessibilityLabel={t('填写疑问或确认结果','Question or confirmation')} multiline editable={!busy} value={input} onChangeText={text=>{setInput(text);publishDraft({...draftRef.current,text,kind:mode});}} placeholderTextColor={c.foregroundMuted} style={{...normal,padding:8,borderWidth:1,borderColor:c.border,minHeight:80}}/>
   {button(t('保存','Save'),()=>void save(mode))}
  </>:mode==='copy'?<TextInput accessibilityLabel={t('手动复制内容','Manual copy content')} multiline editable={false} value={full} style={{...normal,minHeight:100}}/>:<>
   {!current?<Text style={{...normal,color:c.statusWarning}}>{t('此说明针对原快照，未自动迁移','This explanation belongs to its original snapshot')}</Text>:null}
   {[[t('需求依据','Requirement'),n.basis==='requirement'?n.requirement:t(n.basis==='autonomous'?'自主调整，待确认':'缺少需求上下文',n.basis==='autonomous'?'Autonomous adjustment; needs confirmation':'Requirement context missing')],[t('修改原因','Reason'),n.reason],[t('行为变化','Behavior change'),n.behavior],[t('需要确认','Needs confirmation'),n.question],[t('提交者提供的验证依据','Author-provided evidence'),n.evidence]].filter(x=>x[1]).map(([label,value])=><View key={label}><Text style={muted}>{label}</Text><Text selectable style={normal}>{value}</Text></View>)}
   {n.anchors.map((a,i)=><Pressable key={i} accessibilityRole="button" onPress={()=>onAnchor?.(i)} style={{paddingVertical:5}}><Text style={{...muted,color:accent}}>{a.path} · {a.side} {a.start?`${a.start}–${a.end}`:''}</Text></Pressable>)}
   <Text selectable style={muted}>{t(n.perspective==='implementer'?'实现者说明':'根据代码推断',n.perspective==='implementer'?'Implementer explanation':'Inferred from code')} · {note.author}{note.editedBy==='user'?t(' · 用户修订',' · Edited by user'):''} · v{note.revision}</Text>
   <Text selectable style={muted}>{snapshot?.left||'∅'} → {snapshot?.right||t('工作树快照','Working snapshot')}</Text>
   {events.map((e,i)=><View key={e.eventId||i}><Text selectable style={muted}>{e.action==='read'?t('已阅（不代表认可）','Read (not approval)'):`${e.action==='question'?t('疑问','Question'):t('用户确认记录','User confirmation')}: ${e.text}`}</Text>{!note.historical&&e.action==='question'&&e.eventId?<View style={{flexDirection:'row',gap:12}}>{button(t('编辑疑问','Edit question'),()=>startQuestion(e,'question-edit'))}{button(t('删除疑问','Delete question'),()=>startQuestion(e,'question-delete'))}</View>:null}</View>)}
   {onOriginal?button(t('查看原快照','View original snapshot'),()=>{void onOriginal().then(setOriginal).catch(e=>setError(String(e)));}):null}
   {original?<><Text style={muted}>{t('原快照文本','Original snapshot text')} · {originalPage+1}/{Math.ceil(original.length/8192)}</Text><Text selectable style={{...normal,fontFamily:'monospace'}}>{original.slice(originalPage*8192,(originalPage+1)*8192)}</Text><View style={{flexDirection:'row'}}>{originalPage>0?button(t('上一页','Previous page'),()=>setOriginalPage(p=>p-1)):null}{(originalPage+1)*8192<original.length?button(t('下一页','Next page'),()=>setOriginalPage(p=>p+1)):null}</View></>:null}
  </>}
  {note.historical?<><Text style={muted}>{t(`历史修订 v${note.revision}（只读）`,`Historical revision v${note.revision} (read only)`)}</Text>{onLatest?button(t('查看最新版本','View latest revision'),()=>{void onLatest().catch(e=>{if(mounted.current)setError(String(e));});}):null}</>:null}
  {error?<Text style={{...normal,color:c.statusDanger}}>{error}</Text>:null}
 </View>;
}
