import type {ReactNode} from 'react';
import {useCallback,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Platform,Pressable,Text,View} from 'react-native';
import type {PluginWorkspacePanelProps} from '@getpaseo/plugin/client';
import {Icon,ScrollView,useToast} from '../native-components';
import {IconButton} from './icon-button';
import {ComparisonPopover,type PopoverAnchor} from './comparison-popover';
import {selectionKey,type FileReviewSelection} from '../file-review-store';
import {diffReadingReferences,diffTabLabels,diffToolbarLayout} from '../diff-toolbar-model';
import type {DiffResult} from '../model';
import type {DiffReading} from '../use-diff-reading';
import type {ReviewMode} from '../review-mode';
import {useWorkbenchCopy,useWorkbenchLocale} from '../i18n';
import {observerAccent} from '../theme';

type Props={extra?:ReactNode;selections:FileReviewSelection[];activeKey:string;selection?:FileReviewSelection;diff:DiffResult|null;reading:DiffReading;
 onSelect(key:string):void;onClose(selection:FileReviewSelection):void;width:number;theme:PluginWorkspacePanelProps['theme'];
 mode:ReviewMode;narrow:boolean;onMode():void;fontSize:number;wrap:boolean;onDisplay(patch:{fontSize?:number;wrap?:boolean}):void;stale:boolean;retry?:()=>void};
export function DiffToolbar(props:Props){
 const {selections,activeKey,selection,diff,reading,width,theme,mode,narrow,onMode,fontSize,wrap,onDisplay,onSelect,onClose,stale,retry}=props;
 const copy=useWorkbenchCopy(),locale=useWorkbenchLocale(),toast=useToast(),zh=locale==='zh-CN';
 const text=(cn:string,en:string)=>zh?cn:en;
 const colors=theme.colors,accent=observerAccent(theme),touch=Platform.OS!=='web',layout=diffToolbarLayout(width,touch);
 const labels=useMemo(()=>diffTabLabels(selections),[selections]);
 const references=diffReadingReferences(selection,diff);
 const [tabWidth,setTabWidth]=useState(0);
 const [overlay,setOverlay]=useState<'more'|'details'|null>(null);
 const [anchor,setAnchor]=useState<PopoverAnchor>({x:0,y:0,width:Math.max(width,280),height:layout.minHeight});
 const root=useRef<any>(null),tabs=useRef<any>(null),frames=useRef(new Map<string,{x:number;width:number}>()),viewport=useRef(0),offset=useRef(0);
 const reveal=useCallback(()=>{
  const frame=frames.current.get(activeKey);if(!frame||!viewport.current)return;
  const next=frame.x<offset.current?frame.x:frame.x+frame.width>offset.current+viewport.current?Math.max(0,frame.x+frame.width-viewport.current):offset.current;
  if(next!==offset.current){offset.current=next;tabs.current?.scrollTo?.({x:next,animated:false});}
 },[activeKey]);
 useLayoutEffect(()=>{setOverlay(null);reveal();},[activeKey,reveal]);
 const open=(kind:'more'|'details')=>{root.current?.measureInWindow?.((x:number,y:number,w:number,height:number)=>setAnchor({x,y,width:w,height}));setOverlay(kind);};
 const muted={color:colors.foregroundMuted,fontSize:12},normal={color:colors.foreground,fontSize:12};
 const closeLabel=text('关闭 Diff 设置','Close Diff settings');
 const item=(label:string,action:()=>void,disabled=false)=><Pressable accessibilityRole="button" disabled={disabled} accessibilityState={{disabled}} onPress={action} style={{paddingVertical:touch?12:8,opacity:disabled?0.5:1}}><Text style={normal}>{label}</Text></Pressable>;
 const detail=(label:string,value:string|null|undefined)=>value?<View style={{gap:3,paddingVertical:5}}><Text style={muted}>{label}</Text><Text selectable style={normal}>{value}</Text></View>:null;
 const modeControl=<IconButton label={narrow?text('窄窗口使用单栏','Narrow window uses unified Diff'):mode==='split'?copy.switchToUnified:copy.switchToSplit} icon={mode==='split'?'Columns2':'Rows3'} color={narrow?colors.foregroundMuted:accent} disabled={narrow} active={mode==='split'} onPress={onMode}/>;
 return <>
  <View ref={root} testID="diff-single-toolbar" style={{flexDirection:'row',alignItems:'center',minHeight:layout.minHeight,flexShrink:0,borderBottomWidth:1,borderBottomColor:colors.border,backgroundColor:colors.surface1,paddingHorizontal:4,gap:4}}>
   <ScrollView ref={tabs} horizontal showsHorizontalScrollIndicator={false} testID="diff-file-tabs" style={{flex:1,minWidth:0}} contentContainerStyle={{alignItems:'center',gap:2}}
    onLayout={event=>{viewport.current=event.nativeEvent.layout.width;setTabWidth(viewport.current);reveal();}} onContentSizeChange={reveal} onScroll={event=>{offset.current=event.nativeEvent.contentOffset.x;}} scrollEventThrottle={16}>
    {selections.map((entry,index)=>{
      const key=selectionKey(entry),active=key===activeKey;
      const description=`${entry.workspaceId} / ${entry.repoPath} / ${entry.path}`;
      return <View key={key} onLayout={event=>{frames.current.set(key,event.nativeEvent.layout);if(active)reveal();}}
       {...(Platform.OS==='web'?{onAuxClick:(event:any)=>{if(event.button===1){event.preventDefault();onClose(entry);}}}:{} )}
       style={{flexDirection:'row',alignItems:'center',minHeight:layout.minHeight-1,borderBottomWidth:2,borderBottomColor:active?accent:'transparent',backgroundColor:active?colors.surface2:'transparent',flexShrink:0}}>
       <Pressable accessibilityRole="tab" accessibilityLabel={labels[index]} accessibilityState={{selected:active}} onPress={()=>onSelect(key)} onLongPress={()=>toast.show(description)}
        {...(Platform.OS==='web'?{title:description,'aria-selected':active}:{})} style={{flexDirection:'row',alignItems:'center',paddingHorizontal:8,minHeight:touch?44:30,gap:5,maxWidth:260}}>
        <Text style={{fontSize:12,fontWeight:'700',color:entry.status==='A'?colors.statusSuccess:entry.status==='D'?colors.statusDanger:entry.status==='R'?accent:colors.statusWarning}}>{entry.status||'M'}</Text>
        {active&&stale?<Icon name="CircleAlert" size={12} color={colors.statusWarning}/>:null}
        <Text numberOfLines={1} style={[normal,{flexShrink:1,maxWidth:tabWidth?Math.min(210,Math.max(24,tabWidth-(touch?76:58))):210}]}>{labels[index]}</Text>
       </Pressable>
       <IconButton label={`${text('关闭','Close')} ${labels[index]}`} icon="X" color={colors.foregroundMuted} onPress={()=>onClose(entry)}/>
      </View>;
    })}
    {!selections.length?<Text style={muted}>{copy.text_336884b48e}</Text>:null}
   </ScrollView>
   <View testID="diff-toolbar-actions" style={{flexDirection:'row',alignItems:'center',flexShrink:0,gap:2}}>
    {layout.showRange&&references?<Pressable testID="diff-short-range" accessibilityRole="button" accessibilityLabel={text('比较详情','Comparison details')} onPress={()=>open('details')} style={{maxWidth:220,paddingHorizontal:6,minHeight:touch?44:28,justifyContent:'center'}}><Text numberOfLines={1} style={muted}>{references.fromLabel} → {references.toLabel}</Text></Pressable>:null}
    {reading.hunkRowIndexes.length?<View testID="diff-hunk-navigation" style={{flexDirection:'row',alignItems:'center'}}>
      <IconButton label={copy.text_0d310558b7} icon="ChevronLeft" color={colors.foreground} onPress={()=>reading.jumpToHunk(reading.currentHunk-1)}/>
      <Text testID="diff-hunk-count" style={[muted,{textAlign:'center',minWidth:34}]}>{Math.min(reading.currentHunk+1,reading.hunkRowIndexes.length)} / {reading.hunkRowIndexes.length}</Text>
      <IconButton label={copy.text_d8b1574142} icon="ChevronRight" color={colors.foreground} onPress={()=>reading.jumpToHunk(reading.currentHunk+1)}/>
    </View>:null}
    {props.extra}
    {layout.showMode?modeControl:null}
    {retry?<IconButton label={copy.refreshNow} icon="CircleAlert" color={colors.statusWarning} onPress={retry}/>:null}
    <IconButton label={text('Diff 阅读设置','Diff reading settings')} icon="Ellipsis" color={colors.foregroundMuted} onPress={()=>open('more')}/>
   </View>
  </View>
  {overlay?<ComparisonPopover title={overlay==='more'?text('Diff 阅读设置','Diff reading settings'):text('比较详情','Comparison details')} testID="diff-reading-popover" closeLabel={closeLabel} anchor={anchor} onClose={()=>setOverlay(null)} theme={theme}>
    {overlay==='more'?<>
      <Text style={muted}>{text('代码字号','Code size')}</Text>
      <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>{[12,14,16,18].map(size=><Pressable key={size} accessibilityRole="button" accessibilityLabel={`${size}px`} accessibilityState={{selected:size===fontSize}} onPress={()=>onDisplay({fontSize:size})} style={{padding:touch?12:8,borderBottomWidth:2,borderBottomColor:size===fontSize?accent:'transparent'}}><Text style={normal}>{size}px</Text></Pressable>)}</View>
      {item(wrap?text('关闭自动换行','Disable line wrapping'):text('自动换行','Wrap lines'),()=>onDisplay({wrap:!wrap}))}
      {!layout.showMode?item(narrow?text('窄窗口使用单栏','Narrow window uses unified Diff'):mode==='split'?copy.switchToUnified:copy.switchToSplit,onMode,narrow):null}
      {item(text('比较详情','Comparison details'),()=>setOverlay('details'),!selection)}
      <Text style={[muted,{paddingVertical:8}]}>{copy.readOnlyBadge}</Text>
    </>:<>
      {detail(text('工作区','Workspace'),selection?.workspaceId)}
      {detail(text('仓库','Repository'),selection?.repoPath)}
      {detail(text('文件','File'),selection?.path)}
      {detail(text('原路径','Original path'),diff?.oldPath||selection?.oldPath)}
      {detail(text('变化类型','Change'),diff?.statusLabel||selection?.statusLabel)}
      {detail(text('打开时的分支','Branch when opened'),selection?.branch)}
      {references?<>
       {detail(text('比较方式','Comparison mode'),references.mode==='commit'?text('单提交：父提交到所选提交（根提交从空树开始）','Single commit: parent to selected commit (empty tree for a root commit)'):references.mode==='working'?text('未提交变化','Uncommitted changes'):references.mode==='contribution'?text('本分支引入的改动','Changes introduced by this branch'):references.mode==='endpoints'?text('两端差异','Endpoint differences'):text('相对创建基线','Relative to creation base'))}
       {detail(text('起点引用','From reference'),references.fromRef)}{detail(text('起点引用 SHA','From reference SHA'),references.fromRefSha)}
       {detail(text('实际起点','Actual start'),references.from||text('空内容','Empty content'))}
       {detail(text('终点引用','To reference'),references.toRef)}{detail(text('实际终点','Actual end'),references.to||text('工作树','Working tree'))}
       {detail(text('共同祖先','Merge base'),references.mergeBase)}
       {detail(text('补充信息','Patch metadata'),reading.parsed.prelude.join('\n'))}
      </>:<Text style={muted}>{text('内容尚未读到，比较身份待确认。','Content is not available; comparison identity is pending.')}</Text>}
      <Text style={[muted,{paddingVertical:8}]}>{copy.readOnlyBadge}</Text>
    </>}
  </ComparisonPopover>:null}
 </>;
}
