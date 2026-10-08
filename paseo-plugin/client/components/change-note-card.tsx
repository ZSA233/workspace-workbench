import {observerAccent} from '../theme';
import {noteNeedsConfirmation} from '../change-notes-model';
import {useState,useRef,useEffect} from 'react';
import {Pressable,Text,View} from 'react-native';
import {TextInput,copyText,Icon} from '../native-components';
import {IconButton} from './icon-button';
import {useWorkbenchLocale} from '../i18n';
import type {ChangeNote,NotesResult} from '../../shared/change-notes';
import type {NoteDraft} from '../note-popover-model';
import type {PluginWorkspacePanelProps} from '@getpaseo/plugin/client';
type Props={note:ChangeNote;data:NotesResult;current:boolean;theme:PluginWorkspacePanelProps['theme'];draft:NoteDraft;
 onDraftChange(value:NoteDraft,expected?:NoteDraft):void;onExpanded(value:boolean):void;onOriginal?:()=>Promise<string>;onClose():void;
 onFeedback(action:'read'|'question'|'confirm',text?:string):Promise<void>;onAnchor?(index:number):void};
/** The default view is intentionally small; the full explanation is preserved in details. */
export function ChangeNoteCard({note,data,current,theme,draft,onDraftChange,onExpanded,onClose,onFeedback,onAnchor,onOriginal}:Props){
 const zh=useWorkbenchLocale()==='zh-CN',t=(a:string,b:string)=>zh?a:b,c=theme.colors,accent=observerAccent(theme);
 const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const [mode,setMode]=useState<'brief'|'details'|'more'|'question'|'confirm'|'copy'>('brief');
 const [original,setOriginal]=useState(''),[originalPage,setOriginalPage]=useState(0),[input,setInput]=useState(draft.text),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const n=note.content,events=data.feedback.filter(e=>e.id===note.id&&e.revision===note.revision),snapshot=data.snapshots[note.snapshotId];
 const normal={color:c.foreground,fontSize:13,lineHeight:20},muted={color:c.foregroundMuted,fontSize:12,lineHeight:18};
 function show(value:typeof mode){if(!mounted.current)return;setMode(value);onExpanded(value!=='brief');setError('');}
 function edit(kind:'question'|'confirm'){onDraftChange({text:input,kind});show(kind);}
 async function save(action:'read'|'question'|'confirm'){
  const captured={text:input,kind:action==='read'?null:action} as NoteDraft;
  setBusy(true);setError('');try{await onFeedback(action,input);if(action!=='read'){onDraftChange({text:'',kind:null},captured);if(mounted.current)setInput('');}show('brief');}catch(e){if(mounted.current)setError(String(e));}finally{if(mounted.current)setBusy(false);}
 }
 const button=(label:string,action:()=>void)=><Pressable accessibilityRole="button" disabled={busy} onPress={action} style={{paddingVertical:8,paddingHorizontal:4}}><Text style={{...normal,color:accent}}>{label}</Text></Pressable>;
 const full=[n.title,`Author: ${note.author}`,`Perspective: ${n.perspective}`,`Project: ${snapshot?.projectId||''}`,`Workspace: ${snapshot?.workspaceId||''}`,`Repository: ${snapshot?.repoPath||''}`,`Snapshot: ${note.snapshotId}`,`Range: ${snapshot?.left||'empty'} → ${snapshot?.right||'working snapshot'}`,`Reason: ${n.reason}`,`Behavior: ${n.behavior}`,`Requirement (${n.basis}): ${n.requirement}`,`Question: ${n.question}`,`Author-provided evidence: ${n.evidence}`,...n.anchors.map(a=>`${a.path} (${a.side}) ${a.start||''}-${a.end||''}`),...events.filter(e=>e.action!=='read').map(e=>`${e.action}: ${e.text}`)].join('\n');
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
    <IconButton label={t('提出疑问','Ask a question')} icon="MessageSquare" color={c.foregroundMuted} onPress={()=>edit('question')}/>
    <IconButton label={t('说明操作','Explanation actions')} icon="Ellipsis" color={c.foregroundMuted} onPress={()=>show('more')}/>
    <View style={{flex:1}}/>{button(t('详情','Details'),()=>show('details'))}
   </View>
  </>:mode==='more'?<>
   {button(t('已阅','Read'),()=>void save('read'))}{button(t('复制说明与疑问','Copy explanation and questions'),()=>void copy())}{button(t('记录确认结果','Record confirmation'),()=>edit('confirm'))}
  </>:mode==='question'||mode==='confirm'?<>
   <Text style={muted}>{mode==='question'?t('疑问仅保存在本地，不自动发送','Saved locally; no message is sent'):t('记录你的判断；已阅不代表认可','Record your decision; reading is not approval')}</Text>
   <TextInput testID="note-feedback-input" accessibilityLabel={t('填写疑问或确认结果','Question or confirmation')} multiline editable={!busy} value={input} onChangeText={text=>{setInput(text);onDraftChange({text,kind:mode});}} placeholderTextColor={c.foregroundMuted} style={{...normal,padding:8,borderWidth:1,borderColor:c.border,minHeight:80}}/>
   {button(t('保存','Save'),()=>void save(mode))}
  </>:mode==='copy'?<TextInput accessibilityLabel={t('手动复制内容','Manual copy content')} multiline editable={false} value={full} style={{...normal,minHeight:100}}/>:<>
   {!current?<Text style={{...normal,color:c.statusWarning}}>{t('此说明针对原快照，未自动迁移','This explanation belongs to its original snapshot')}</Text>:null}
   {[[t('需求依据','Requirement'),n.basis==='requirement'?n.requirement:t(n.basis==='autonomous'?'自主调整，待确认':'缺少需求上下文',n.basis==='autonomous'?'Autonomous adjustment; needs confirmation':'Requirement context missing')],[t('修改原因','Reason'),n.reason],[t('行为变化','Behavior change'),n.behavior],[t('需要确认','Needs confirmation'),n.question],[t('提交者提供的验证依据','Author-provided evidence'),n.evidence]].filter(x=>x[1]).map(([label,value])=><View key={label}><Text style={muted}>{label}</Text><Text selectable style={normal}>{value}</Text></View>)}
   {n.anchors.map((a,i)=><Pressable key={i} accessibilityRole="button" onPress={()=>onAnchor?.(i)} style={{paddingVertical:5}}><Text style={{...muted,color:accent}}>{a.path} · {a.side} {a.start?`${a.start}–${a.end}`:''}</Text></Pressable>)}
   <Text selectable style={muted}>{t(n.perspective==='implementer'?'实现者说明':'根据代码推断',n.perspective==='implementer'?'Implementer explanation':'Inferred from code')} · {note.author} · v{note.revision}</Text>
   <Text selectable style={muted}>{snapshot?.left||'∅'} → {snapshot?.right||t('工作树快照','Working snapshot')}</Text>
   {events.map((e,i)=><Text selectable key={i} style={muted}>{e.action==='read'?t('已阅（不代表认可）','Read (not approval)'):`${e.action==='question'?t('疑问','Question'):t('用户确认记录','User confirmation')}: ${e.text}`}</Text>)}
   {onOriginal?button(t('查看原快照','View original snapshot'),()=>{void onOriginal().then(setOriginal).catch(e=>setError(String(e)));}):null}
   {original?<><Text style={muted}>{t('原快照文本','Original snapshot text')} · {originalPage+1}/{Math.ceil(original.length/8192)}</Text><Text selectable style={{...normal,fontFamily:'monospace'}}>{original.slice(originalPage*8192,(originalPage+1)*8192)}</Text><View style={{flexDirection:'row'}}>{originalPage>0?button(t('上一页','Previous page'),()=>setOriginalPage(p=>p-1)):null}{(originalPage+1)*8192<original.length?button(t('下一页','Next page'),()=>setOriginalPage(p=>p+1)):null}</View></>:null}
  </>}
  {error?<Text style={{...normal,color:c.statusDanger}}>{error}</Text>:null}
 </View>;
}
