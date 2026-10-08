import {useState} from 'react';
import {Pressable,Text,View} from 'react-native';
import {TextInput,copyText} from '../native-components';
import {IconButton} from './icon-button';
import {ChangeNoteCard} from './change-note-card';
import {useChangeNotes} from '../use-change-notes';
import {shortComparisonRef} from '../comparison-display';
import {comparisonRecordState} from '../comparison-notes-model';
import type {useComparisonNotes} from '../use-comparison-notes';
import type {ComparisonNoteRecord} from '../../shared/change-notes';
import type {NoteDraft} from '../note-popover-model';
import type {PluginWorkspacePanelProps} from '@getpaseo/plugin/client';
type Props={project:string;workspaceId:string;repoPath:string;theme:PluginWorkspacePanelProps['theme'];catalog:ReturnType<typeof useComparisonNotes>;search:string;onSearch(value:string):void;onSelect(record:ComparisonNoteRecord):void;requestText:string;refs:Array<{name:string;shortName:string;sha?:string}>;head?:string};
export function ComparisonNoteDirectory(props:Props){
 const {catalog,theme,search,onSearch,onSelect}=props,c=theme.colors;
 const [detail,setDetail]=useState<ComparisonNoteRecord|null>(null),[copyFallback,setCopyFallback]=useState(false),[copied,setCopied]=useState(false);
 const text={color:c.foreground,fontSize:13},muted={color:c.foregroundMuted,fontSize:11};
 const pages=catalog.data?.pages,records=pages?.flatMap(p=>p.records)||[];
 if(detail)return <SavedComparisonNotes key={detail.id} {...props} record={detail} onBack={()=>setDetail(null)}/>;
 return <View testID="comparison-note-directory" style={{gap:8}}>
  <Text style={muted}>{props.workspaceId} / {props.repoPath}</Text>
  <TextInput accessibilityLabel="搜索比较说明" placeholder="搜索分支、SHA 或说明" value={search} onChangeText={value=>{onSearch(value);setCopied(false);}} maxLength={256} style={{...text,borderWidth:1,borderColor:c.border,borderRadius:4,padding:8}}/>
  {catalog.error?<><Text style={{...muted,color:c.statusWarning}}>{catalog.error.message}</Text><Pressable accessibilityRole="button" onPress={()=>void catalog.refetch()}><Text style={text}>重新读取目录</Text></Pressable></>:null}
  {!pages&&catalog.isFetching?<Text style={muted}>正在读取说明记录…</Text>:null}
  {records.map(record=><View key={record.id} testID={`comparison-note-record-${record.id}`} style={{flexDirection:'row',alignItems:'center',borderBottomWidth:1,borderBottomColor:c.border,paddingVertical:8}}>
   <Pressable accessibilityRole="button" accessibilityLabel={`打开比较 ${shortComparisonRef(record.comparison.fromRef)} 到 ${shortComparisonRef(record.comparison.toRef)} ${record.comparison.toSha.slice(0,8)}`} onPress={()=>onSelect(record)} style={{flex:1,minWidth:0,gap:5}}>
    <Text numberOfLines={1} style={text}>{shortComparisonRef(record.comparison.fromRef)} → {shortComparisonRef(record.comparison.toRef)}</Text>
    <Text style={muted}>{record.noteCount} 条说明{record.pendingCount?` · ${record.pendingCount} 项待确认`:''} · {comparisonRecordState(record,props.refs,props.head)==='historical'?'历史版本':'固定版本'}</Text>
    <Text style={muted}>{record.comparison.fromSha.slice(0,8)} → {record.comparison.toSha.slice(0,8)} · {new Date(record.updatedAt).toLocaleString(undefined,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}</Text>
   </Pressable>
   <IconButton icon="MessageSquare" label={`查看比较说明 ${record.comparison.toSha.slice(0,8)}`} color={c.foregroundMuted} onPress={()=>setDetail(record)}/>
  </View>)}
  {pages&&!records.length?<Text style={muted}>{search?'没有匹配的比较说明':'此仓库尚无比较说明'}</Text>:null}
  {catalog.hasNextPage?<Pressable accessibilityRole="button" disabled={catalog.isFetching} onPress={()=>void catalog.fetchNextPage()} style={{padding:8}}><Text style={text}>加载更多</Text></Pressable>:null}
  <Pressable accessibilityRole="button" disabled={!props.requestText} onPress={()=>{void copyText(props.requestText).then(()=>setCopied(true)).catch(()=>setCopyFallback(true));}} style={{paddingVertical:8,opacity:props.requestText?1:0.5}}><Text style={text}>{copied?'已复制说明请求':'复制本次比较的说明请求'}</Text></Pressable>
  {copyFallback?<TextInput accessibilityLabel="手动复制比较说明请求" multiline editable={false} value={props.requestText} style={{...text,minHeight:100}}/>:null}
 </View>;
}
function SavedComparisonNotes(props:Props&{record:ComparisonNoteRecord;onBack():void}){
 const {record,theme}=props,c=theme.colors;
 const [selected,setSelected]=useState(''),[latest,setLatest]=useState(''),[draft,setDraft]=useState<NoteDraft>({text:'',kind:null});
 const query=useChangeNotes({projectConfig:props.project,workspaceId:props.workspaceId,repoPath:props.repoPath,scope:latest?'branch':'compare',comparison:latest?undefined:record.comparison,noteComparisonId:latest?undefined:record.id,noteId:latest||undefined});
 const note=query.data?.notes.find(n=>n.id===(latest||selected));
 const displayed=latest?(note?query.data?.snapshots[note.snapshotId]?.comparison as ComparisonNoteRecord['comparison']|undefined:undefined):record.comparison;
 return <View testID="saved-comparison-notes" style={{gap:8}}>
  <IconButton label="返回比较说明目录" icon="ArrowLeft" color={c.foreground} onPress={props.onBack}/>
  <Text selectable style={{color:c.foreground,fontSize:12}}>{displayed?`${displayed.fromRef} → ${displayed.toRef}`:latest?'最新说明':'比较说明'}</Text>
  <Text selectable style={{color:c.foregroundMuted,fontSize:11}}>{displayed?`${displayed.fromSha}\n${displayed.toSha}\n${displayed.mode==='contribution'?'共同祖先差异':'两端差异'}${displayed.mergeBase?`\n${displayed.mergeBase}`:''}`:''}</Text>
  {!latest&&record.aliases.length>1?<Text selectable style={{color:c.foregroundMuted,fontSize:11}}>其他引用：{record.aliases.map(a=>`${a.fromRef} → ${a.toRef}`).join('；')}</Text>:null}
  {!latest?<Pressable accessibilityRole="button" onPress={()=>props.onSelect(record)}><Text style={{color:c.foreground,fontSize:13,paddingVertical:8}}>查看该版本文件差异</Text></Pressable>:null}
  {query.isPending?<Text style={{color:c.foregroundMuted}}>正在读取说明…</Text>:null}
  {query.error?<Pressable accessibilityRole="button" onPress={()=>void query.refetch()}><Text style={{color:c.statusWarning}}>{query.error.message} · 重试</Text></Pressable>:null}
  {!note?query.data?.notes.map(n=><Pressable key={n.id} accessibilityRole="button" onPress={()=>{setSelected(n.id);setDraft({text:'',kind:null});}} style={{paddingVertical:8}}><Text style={{color:c.foreground}}>{n.content.title}{n.historical?' · 历史修订':''}</Text></Pressable>):null}
  {query.data&&!query.data.notes.length?<Text style={{color:c.foregroundMuted}}>说明已撤回或此记录已无说明。</Text>:null}
  {note&&query.data?<ChangeNoteCard key={`${note.id}:${note.revision}`} note={note} data={query.data} current theme={theme} draft={draft} onDraftChange={setDraft} onExpanded={()=>{}} onClose={()=>{setSelected('');setLatest('');}} onOriginal={()=>query.original(note)} onFeedback={(a,t)=>query.feedback(note,a,t)} onManage={edit=>query.manage(note,edit)} onLatest={async()=>{setSelected(note.id);setLatest(note.id);setDraft({text:'',kind:null});}}/>:null}
 </View>;
}
