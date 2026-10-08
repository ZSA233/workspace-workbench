import {observerAccent} from '../theme';
import {useEffect,useState,useRef,useLayoutEffect,useCallback} from 'react';
import {Platform,Pressable,Text,View,useWindowDimensions} from 'react-native';
import type {PluginWorkspacePanelProps} from '@getpaseo/plugin/client';
import type {DiffResult,DiffDisplayRow} from '../model';
import {useChangeNotes,noteCurrent,type NoteScope} from '../use-change-notes';
import {noteNeedsConfirmation} from '../change-notes-model';
import {ChangeNoteCard} from './change-note-card';
import {NotePopover} from './note-popover';
import {IconButton} from './icon-button';
import {Icon} from '../native-components';
import {useWorkbenchLocale} from '../i18n';
import {scheduleNoteFrame,noteAnchorVisible,type NoteRect,type NoteDraft} from '../note-popover-model';
import type {ChangeNote} from '../../shared/change-notes';
type Placements={byRow:Map<number,string[]>;first:Map<string,number>};
type Popup={view:string;key:string;anchor:NoteRect;ids:string[];selected:string|null};
function NoteMarker({markerKey,ids,selected,pending,label,color,pendingColor,onPress,register,onLayout}:{markerKey:string;ids:string[];selected:boolean;pending:boolean;label:string;color:string;pendingColor:string;onPress():void;register(key:string,node:any):void;onLayout():void}){
 const node=useRef<any>(null);
 useLayoutEffect(()=>{register(markerKey,node.current);return()=>register(markerKey,null);},[markerKey,register]);
 return <View ref={node} collapsable={false} testID={`note-marker-${markerKey}`} onLayout={onLayout} style={{position:'absolute',left:0,top:0,zIndex:3}}>
  <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{expanded:selected}} onPress={onPress} hitSlop={Platform.OS==='web'?2:8} style={{width:22,height:22,alignItems:'center',justifyContent:'center'}}>
   <Icon name="MessageSquare" size={14} color={color}/>{pending?<View style={{position:'absolute',right:1,top:1,width:5,height:5,borderRadius:3,backgroundColor:pendingColor}}/>:null}
   {ids.length>1?<Text style={{position:'absolute',right:-4,bottom:0,fontSize:9,color}}>{ids.length}</Text>:null}
  </Pressable>
 </View>;
}
/** Holds interaction state only; result data stays in React Query. */
export function useDiffNotes(scope:NoteScope|undefined,diff:DiffResult|null,enabled:boolean,theme:PluginWorkspacePanelProps['theme'],openOther?:(anchor:ChangeNote['content']['anchors'][number],note:ChangeNote,data:import('../../shared/change-notes').NotesResult)=>void){
 const query=useChangeNotes(scope,enabled&&!!diff),zh=useWorkbenchLocale()==='zh-CN',window=useWindowDimensions();
 const toolbarRef=useRef<any>(null),layerRef=useRef<any>(null),nodes=useRef(new Map<string,any>()),epoch=useRef(0);
 const view=JSON.stringify([scope?.projectConfig,scope?.workspaceId,scope?.repoPath,scope?.path,scope?.scope,scope?.commitSha,scope?.comparison]);
 const latestView=useRef(view);latestView.current=view;
 const [bounds,setBounds]=useState<NoteRect>({x:0,y:0,width:0,height:0});const boundsRef=useRef(bounds);boundsRef.current=bounds;
 const [popup,setPopup]=useState<Popup|null>(null),popupRef=useRef(popup);popupRef.current=popup;
 const [expanded,setExpanded]=useState(false);
 const drafts=useRef(new Map<string,NoteDraft>());
 const pending=useRef<{view:string;id:string;anchor?:ChangeNote['content']['anchors'][number];jumped:boolean;keepPosition?:boolean;settled?:boolean;frame?:()=>void}|null>(null);
 const driver=useRef<{view:string;rows:DiffDisplayRow[];placements:Placements;jump(index:number):void}|null>(null);
 const retry=useRef(()=>{}),remeasure=useRef(()=>{});
 const close=useCallback((restoreFocus=false)=>{if(restoreFocus&&Platform.OS==='web'){const key=popupRef.current?.key,node=key==='toolbar'?toolbarRef.current:key?nodes.current.get(key):null;node?.querySelector?.('[role="button"],button')?.focus?.({preventScroll:true});}epoch.current++;if(pending.current?.frame)pending.current.frame();pending.current=null;popupRef.current=null;setPopup(null);setExpanded(false);},[]);
 useLayoutEffect(()=>{close();},[view,close]);
 useEffect(()=>{if(!enabled)close();},[enabled,close]);
 useEffect(()=>()=>{epoch.current++;if(pending.current?.frame)pending.current.frame();},[]);
 const data=query.data,notes=data?.notes.filter(n=>n.content.anchors.some(a=>a.path===scope?.path))||[];
 const current=(n:ChangeNote)=>!!data&&!!scope&&noteCurrent(n,data,scope,diff);
 const active=popup?.view===view?notes.find(n=>n.id===popup.selected):undefined;
 const rowKey=(key:string)=>`${view}:${key}`;
 const measure=(key:string,ids:string[],selected:string|null,onOutside?:()=>void)=>{
  const source=key==='toolbar'?toolbarRef.current:nodes.current.get(key),generation=epoch.current,capturedView=view;
  if(!source||!layerRef.current)return;
  layerRef.current.measureInWindow?.((x:number,y:number,width:number,height:number)=>{
   if(epoch.current!==generation||latestView.current!==capturedView)return;
   if(width<=0||height<=0){close();return;}
   const area={x,y,width,height};setBounds(area);boundsRef.current=area;
   source.measureInWindow?.((ax:number,ay:number,aw:number,ah:number)=>{
    if(epoch.current!==generation||latestView.current!==capturedView)return;
    const marker={x:ax,y:ay,width:aw,height:ah};
    let codeRight=ax+aw,codeBottom=ay+ah;
    if(Platform.OS==='web'&&key!=='toolbar'){
     const code=source.parentElement?.querySelectorAll?.('[data-testid^="diff-code-"]');
     for(const element of code||[]){const box=element.getBoundingClientRect();codeRight=Math.max(codeRight,box.right);codeBottom=Math.max(codeBottom,box.bottom);}
    }
    const anchor={...marker,width:Math.min(codeRight,area.x+area.width-8)-ax,height:codeBottom-ay};
    if(key!=='toolbar'&&!noteAnchorVisible(marker,area)){if(onOutside)onOutside();else close();return;}
    const request=pending.current;
    if(request?.jumped&&!request.settled){
     if(!request.frame)request.frame=scheduleNoteFrame(()=>{request.frame=scheduleNoteFrame(()=>{request.frame=undefined;if(pending.current===request&&epoch.current===generation){request.settled=true;retry.current();}});});
     return;
    }
    pending.current=null;const next={view:capturedView,key,ids,selected,anchor};popupRef.current=next;setPopup(next);
   });
  });
 };
 function pick(id:string,anchor?:ChangeNote['content']['anchors'][number]){
  const trigger=popupRef.current?.key;
  const row=trigger&&trigger!=='toolbar'?driver.current?.rows.find(r=>rowKey(r.key)===trigger):undefined;
  const local=anchor||notes.find(n=>n.id===id)?.content.anchors.find(a=>a.path===scope?.path&&a.side!=='file'&&row&&row.kind!=='hunk'&&(row.kind==='unified'?[row.line]:[row.left,row.right]).some(line=>(a.side==='old'?line?.oldLine:line?.newLine)===a.start));
  close();pending.current={view,id,anchor:local,jumped:false,keepPosition:!!trigger&&trigger!=='toolbar'&&!anchor};retry.current();
 }
 retry.current=()=>{
  const request=pending.current;if(!request||request.view!==view)return;
  const note=notes.find(n=>n.id===request.id);if(!note)return;
  const target=driver.current;if(!target||target.view!==view)return;
  let index=target.placements.first.get(note.id);
  if(request.anchor){const a=request.anchor;index=target.rows.findIndex(r=>r.kind!=='hunk'&&(r.kind==='unified'?[r.line]:[r.left,r.right]).some(line=>(a.side==='old'?line?.oldLine:line?.newLine)===a.start));if(index<0)index=undefined;}
  if(!current(note)||index===undefined){measure('toolbar',[note.id],note.id);return;}
  const key=rowKey(target.rows[index].key);
  const jump=()=>{if(!request.jumped){request.jumped=true;target.jump(index!);}};
  if(!request.keepPosition)jump();
  if(nodes.current.has(key))measure(key,[note.id],note.id,jump);else jump();
 };
 remeasure.current=()=>{const value=popupRef.current;if(value?.view===view)measure(value.key,value.ids,value.selected);else retry.current();};
 const register=useCallback((key:string,node:any)=>{
  if(node){nodes.current.set(key,node);retry.current();}else{nodes.current.delete(key);if(popupRef.current?.key===key)close();}
 },[close]);
 useEffect(()=>{if(scope?.changeNoteId){pending.current={view,id:scope.changeNoteId,jumped:false};retry.current();}},[view,scope?.changeNoteId,scope?.changeNoteRequest]);
 useEffect(()=>{retry.current();},[query.data,diff]);
 useEffect(()=>{remeasure.current();},[window.width,window.height,window.fontScale]);
 useEffect(()=>{if(popup?.selected&&!notes.some(n=>n.id===popup.selected))close();},[query.data,popup?.selected,close]);
 const toolbar=<View ref={toolbarRef} testID="note-toolbar"><IconButton label={zh?`改动说明 ${notes.length}`:`Change explanations ${notes.length}`} icon={query.error?'CircleAlert':'MessageSquare'} color={query.error?theme.colors.statusWarning:theme.colors.foregroundMuted} onPress={()=>{if(popupRef.current?.key==='toolbar'){close();return;}close();measure('toolbar',notes.map(n=>n.id),null);void query.refetch();}}/></View>;
 const draftKey=active?`${view}:${active.id}:${active.revision}`:'';
 const visible=popup?.view===view?popup:null;
 const overlay=<View ref={layerRef} testID="note-overlay-layer" pointerEvents="box-none" style={{position:'absolute',left:0,right:0,top:0,bottom:0,zIndex:100}} onLayout={()=>{layerRef.current?.measureInWindow?.((x:number,y:number,width:number,height:number)=>{boundsRef.current={x,y,width,height};setBounds({x,y,width,height});remeasure.current();});}}>
  {visible?<NotePopover anchor={visible.anchor} bounds={bounds} brief={!expanded} onClose={close} theme={theme}>
   {active&&data?<ChangeNoteCard key={`${view}:${active.id}:${active.revision}`} note={active} data={data} current={current(active)} theme={theme} draft={drafts.current.get(draftKey)||{text:'',kind:null}} onDraftChange={(value,expected)=>{const old=drafts.current.get(draftKey);if(!expected||old?.text===expected.text&&old?.kind===expected.kind)drafts.current.set(draftKey,value);}} onExpanded={setExpanded} onOriginal={()=>query.original(active)} onClose={()=>close(true)} onFeedback={(a,t)=>query.feedback(active,a,t)} onAnchor={index=>{const a=active.content.anchors[index];if(a.path===scope?.path)pick(active.id,a);else{close();openOther?.(a,active,data);}}}/>:<View style={{padding:10,gap:5}}>
    <View style={{flexDirection:'row',alignItems:'center'}}><Text style={{color:theme.colors.foreground,flex:1}}>{zh?'改动说明':'Change explanations'}</Text><IconButton label={zh?'关闭说明':'Close explanation'} icon="X" color={theme.colors.foregroundMuted} onPress={close}/></View>
    {query.error?<Pressable onPress={()=>void query.refetch()}><Text style={{color:theme.colors.statusWarning}}>{String(query.error.message)} · {zh?'重试':'Retry'}</Text></Pressable>:null}
    {notes.filter(n=>visible.key==='toolbar'||visible.ids.includes(n.id)).map(n=><Pressable key={n.id} accessibilityRole="button" onPress={()=>pick(n.id)} style={{paddingVertical:8,flexDirection:'row',gap:5}}>{!current(n)||data&&noteNeedsConfirmation(n,data)?<Icon name="CircleAlert" size={12} color={theme.colors.statusWarning}/>:null}<Text numberOfLines={2} style={{color:theme.colors.foreground,fontSize:13,flex:1}}>{n.content.title}</Text></Pressable>)}
    {!notes.length?<Text style={{color:theme.colors.foregroundMuted}}>{zh?'暂无说明':'No explanations'}</Text>:null}
   </View>}
  </NotePopover>:null}
 </View>;
 function positions(rows:DiffDisplayRow[]):Placements{
  const result:Placements={byRow:new Map(),first:new Map()};if(!notes.length)return result;
  const old=new Map<number,number>(),next=new Map<number,number>();
  rows.forEach((row,i)=>{if(row.kind==='hunk')return;for(const line of row.kind==='unified'?[row.line]:[row.left,row.right]){if(line?.oldLine!=null)old.set(line.oldLine,i);if(line?.newLine!=null)next.set(line.newLine,i);}});
  for(const note of notes){if(!current(note))continue;for(const a of note.content.anchors){if(a.path!==scope?.path||a.side==='file')continue;const row=(a.side==='old'?old:next).get(a.start||0);if(row===undefined)continue;const ids=result.byRow.get(row)||[];if(!ids.includes(note.id))ids.push(note.id);result.byRow.set(row,ids);if(!result.first.has(note.id))result.first.set(note.id,row);}}
  return result;
 }
 return {toolbar,overlay,positions,positionsKey:JSON.stringify([view,notes.map(n=>[n.id,n.revision,current(n)])]),bindReading(rows:DiffDisplayRow[],placements:Placements,jump:(index:number)=>void){driver.current={view,rows,placements,jump};retry.current();},onScroll(){if(pending.current){if(pending.current.frame)pending.current.frame();pending.current.frame=undefined;pending.current.settled=false;retry.current();return;}if(Platform.OS==='web')close();},onVisible(){retry.current();},renderRow(row:DiffDisplayRow,index:number,placements:Placements){
  const ids=placements.byRow.get(index)||[],key=rowKey(row.key);
  const highlight=!!active&&current(active)&&row.kind!=='hunk'&&active.content.anchors.some(a=>a.path===scope?.path&&a.side!=='file'&&(row.kind==='unified'?[row.line]:[row.left,row.right]).some(line=>{const n=a.side==='old'?line?.oldLine:line?.newLine;return n!=null&&n>=(a.start||0)&&n<=(a.end||0);}));
  if(!ids.length&&!highlight)return null;
  return <>{highlight?<View testID="note-range-highlight" pointerEvents="none" style={{position:'absolute',left:24,top:0,bottom:0,right:0,borderLeftWidth:2,borderLeftColor:observerAccent(theme)}}/>:null}{ids.length?<NoteMarker markerKey={key} ids={ids} selected={visible?.key===key} pending={!!data&&ids.some(id=>{const n=notes.find(n=>n.id===id);return !!n&&noteNeedsConfirmation(n,data);})} label={ids.map(id=>notes.find(n=>n.id===id)?.content.title).join('; ')} color={observerAccent(theme)} pendingColor={theme.colors.statusWarning} register={register} onLayout={()=>retry.current()} onPress={()=>{if(popupRef.current?.key===key){close();return;}close();measure(key,ids,ids.length===1?ids[0]:null);}}/>:null}</>;
 }};
}
export type DiffNotes=ReturnType<typeof useDiffNotes>;
