import {ComparisonNoteDirectory} from './comparison-note-directory';
import {useComparisonNotes} from '../use-comparison-notes';
import {comparisonRecordState,comparisonExplanationRequest} from '../comparison-notes-model';
import type {ComparisonNoteRecord} from '../../shared/change-notes';
import {NoteFilterButton,type NoteFilter} from './note-filter';
import {ComparisonCommitRow} from "./comparison-commit-row";
import {useEffect,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {ActivityIndicator,Platform,Pressable,Text,View,useWindowDimensions} from 'react-native';
import {TextInput,ScrollView,Icon,copyText} from '../native-components';
import {displayedObservation,observationQueryOptions} from '../observation-content';
import {useQueryContinuity} from '../query-continuity';
import {useDisplaySettings} from '../use-display-settings';
import {useObservationVersions} from '../use-observation-versions';
import {openFileReview} from '../file-review-store';
import {comparisonRequest,comparisonRowHeight,sameComparisonRequest,shortComparisonRef,type ComparisonRequest} from '../comparison-display';
import {comparisonKey,type Comparison} from '../../shared/comparison';
import {ChangedTree} from './changes';
import {IconButton} from './icon-button';
import {ComparisonPopover,type PopoverAnchor} from './comparison-popover';
import type {ObserverMethod,ObserverResponse} from '../../shared/observer';
import type {ChangesResult,RepositorySummary} from '../model';
import type {makeStyles} from './ui';
import type {PluginWorkspacePanelProps} from '@getpaseo/plugin/client';
type Props={project:string;workspaceId:string;hostWorkspaceId:string;agentId?:string;directory?:string;repo:RepositorySummary;repositories:RepositorySummary[];onRepository(path:string):void;foreground:boolean;styles:ReturnType<typeof makeStyles>;theme:PluginWorkspacePanelProps['theme'];initialFrom?:string;initialTo?:string;onClose():void;rpc(input:{method:ObserverMethod;params:Record<string,unknown>}):Promise<ObserverResponse>};
type Result=ChangesResult&{workspaceInstance?:string;record?:ComparisonNoteRecord;comparison:Comparison;refs?:{name:string;shortName:string;kind:string;sha?:string}[];commits?:{sha:string;subject:string}[];hasMore?:boolean;offset?:number;fromOnly?:number;toOnly?:number;fetch?:{state:string;ref?:string;error?:string;lastFetchedAt?:string}};
function result(response:unknown):Result|undefined {const value=displayedObservation(response as ObserverResponse|undefined);return value?.ok?value.result as Result:undefined;}
export function RepositoryCompare(props:Props){
 const {project,workspaceId,repo,rpc,styles,theme,foreground}=props;
 const settings=useDisplaySettings(),preferenceKey=JSON.stringify([project,repo.repoPath]);
 const root=useRef<any>(null),[width,setWidth]=useState(320),[height,setHeight]=useState(300);
 const {fontScale}=useWindowDimensions();
 const touch=Platform.OS!=='web',rowHeight=comparisonRowHeight(touch,fontScale||1),accent='#55bcf5';
 const [request,setRequest]=useState<(ComparisonRequest&{record?:ComparisonNoteRecord})|null>(()=>comparisonRequest(props.initialFrom||'',props.initialTo||'HEAD'));
 const [overlay,setOverlay]=useState<'from'|'to'|'menu'|'repositories'|'commit-detail'|'notes'|null>(null),[anchor,setAnchor]=useState<PopoverAnchor>({x:0,y:0,width:320,height:32});
 const [emptyBasis,setEmptyBasis]=useState<ComparisonRequest>({fromRef:'',toRef:props.initialTo||'HEAD',mode:'endpoints'});
 const [draft,setDraft]=useState(''),[fetchError,setFetchError]=useState('');
 const [detailSha,setDetailSha]=useState(''),[lastOpenedCommit,setLastOpenedCommit]=useState('');
 const [noteSearch,setNoteSearch]=useState(''),[requestCopy,setRequestCopy]=useState('');
 const catalog=useComparisonNotes(project,workspaceId,repo.repoPath,'',foreground);
 const searchedCatalog=useComparisonNotes(project,workspaceId,repo.repoPath,noteSearch,foreground&&overlay==='notes');
 const [noteFilter,setNoteFilter]=useState<NoteFilter>('all');
 const [side,setSide]=useState<'files'|'from'|'to'>('files'),[offset,setOffset]=useState(0),[selected,setSelected]=useState(''),[selectedCommit,setSelectedCommit]=useState('');
 const [searchOpen,setSearchOpen]=useState(false),[filter,setFilter]=useState(''),[treeMode,setTreeMode]=useState<'tree'|'files'>('files');
 useObservationVersions(project,[workspaceId],foreground);
 const query=(action:string,comparison:unknown,enabled:boolean,extra:Record<string,unknown>={})=>({
   queryKey:['workspace-workbench',project,'repository-compare',workspaceId,repo.repoPath,action,comparison,extra],
   queryFn:async()=>{const response=await rpc({method:'repository.compare',params:{workspaceId,repoPath:repo.repoPath,action,comparison,...extra}});const r=result(response),record=(comparison as (ComparisonRequest&{record?:ComparisonNoteRecord})|null)?.record;if(action==='files'&&record&&r&&comparisonKey(r.comparison)===comparisonKey(record.comparison))return {...response,result:{...r,comparison:record.comparison,record}};return response;},enabled:foreground&&enabled,...observationQueryOptions,
 });
 const refs=useQuery(query('refs',null,true)),fileOptions=query('files',request,!!request),fileQuery=useQuery(fileOptions);
 const current=result(fileQuery.data);
 const continuity=useQueryContinuity<Result>(JSON.stringify([project,workspaceId,repo.repoPath]),fileOptions.queryKey,current?.comparison&&Array.isArray(current.files)?current:undefined,value=>{const cached=result(value);return cached?.comparison&&Array.isArray(cached.files)?cached:undefined;});
 const data=continuity.displayed;
 const frozen=data?{...data.comparison,fromRef:data.comparison.fromSha,toRef:data.comparison.toSha}:null;
 const counts=useQuery(query('counts',frozen,!!frozen)),stats=useQuery(query('statistics',frozen,!!frozen));
 const commits=useQuery({...query('commits',frozen,!!frozen&&side!=='files',{side,offset}),placeholderData:(previous,previousQuery)=>JSON.stringify(previousQuery?.queryKey[6])===JSON.stringify(frozen)&&(previousQuery?.queryKey[7] as {side?:string})?.side===side?previous:undefined});
 const commitFiles=useQuery({queryKey:['workspace-workbench',project,'repository-changes',workspaceId,repo.repoPath,'commit',selectedCommit],queryFn:()=>rpc({method:'repository.changes',params:{workspaceId,repoPath:repo.repoPath,scope:'commit',commitSha:selectedCommit}}),enabled:foreground&&!!selectedCommit,...observationQueryOptions});
 const refData=result(refs.data),items=refData?.refs||[],production=settings.production[preferenceKey];
 const suggested=items.find(item=>item.name==='refs/remotes/origin/main')||items.find(item=>item.name==='refs/remotes/origin/master');
 const applied=data?.comparison||request?.record?.comparison||request||emptyBasis;
 const shownRecord=data?.record;
 const requestText=data?comparisonExplanationRequest(project,workspaceId,repo.repoPath,data.comparison):'';
 const numbers=result(counts.data),history=result(commits.data),fetchState=refData?.fetch;
 const detailCommit=history?.commits?.find(commit=>commit.sha===detailSha);
 const files=result(stats.data)||data,commitData=result(commitFiles.data);
 const error=fileQuery.data?.error?.message||fileQuery.error?.message||commitFiles.data?.error?.message||commits.data?.error?.message||counts.data?.error?.message||stats.data?.error?.message||refs.data?.error?.message||fetchError||fetchState?.error;
 const pending=foreground&&fileQuery.isFetching;
 const label={color:theme.colors.foreground,fontSize:12},muted={color:theme.colors.foregroundMuted,fontSize:11};
 const inlineRow={height:rowHeight,flexDirection:'row' as const,alignItems:'center' as const,gap:4};
 function open(kind:NonNullable<typeof overlay>){
   setDraft(kind==='from'?applied.fromRef:kind==='to'?applied.toRef:'');
   root.current?.measureInWindow?.((x:number,y:number,w:number)=>setAnchor({x,y,width:w,height:rowHeight*(kind==='from'||kind==='to'?2:1)}));setOverlay(kind);
 }
 function submit(next:(ComparisonRequest&{record?:ComparisonNoteRecord})|null){
   if(!next){open('from');return;}
   if(sameComparisonRequest(request,next)&&request?.record?.id===next.record?.id)void fileQuery.refetch({cancelRefetch:false});
   else setRequest(next);
   setSelectedCommit('');setSide('files');setOffset(0);setOverlay(null);
 }
 function latestComparison(){if(!shownRecord)return;const c=shownRecord.comparison;for(const [side,ref] of [['from',c.fromRef],['to',c.toRef]] as const){if(ref!=='HEAD'&&!items.some(r=>r.name===ref||r.shortName===ref)){open(side);return;}}submit(comparisonRequest(c.fromRef,c.toRef,c.mode));}
 function selectRecord(record:ComparisonNoteRecord){submit({fromRef:record.comparison.fromSha,toRef:record.comparison.toSha,mode:record.comparison.mode,record});}
 function choose(value:string){const candidate={fromRef:overlay==='from'?value:applied.fromRef,toRef:overlay==='to'?value:applied.toRef,mode:applied.mode};const next=comparisonRequest(candidate.fromRef,candidate.toRef,candidate.mode);if(!next){setEmptyBasis(candidate);setOverlay(null);return;}submit(next);}
 const initialized=useRef(false);
 useEffect(()=>{if(foreground&&settings.ready&&!initialized.current){initialized.current=true;if(!request){if(production)submit(comparisonRequest(production));else open('from');}}},[foreground,settings.ready]);
 useEffect(()=>{if(!foreground)setOverlay(null);},[foreground]);
 function menuRow(text:string,action:()=>void,icon?:string,disabled=false){return <Pressable accessibilityRole="button" disabled={disabled} accessibilityState={{disabled}} onPress={action} style={{minHeight:touch?44:32,flexDirection:'row',alignItems:'center',gap:8,opacity:disabled?0.45:1,paddingHorizontal:4}}>{icon?<Icon name={icon} color={theme.colors.foregroundMuted} size={16}/>:null}<Text style={label}>{text}</Text></Pressable>;}
 function openFile(file:ChangesResult['files'][number],commit?:string){
   if(!data)return;setSelected(file.path);
   openFileReview({kind:commit?'file':'comparison',workspaceInstance:data.workspaceInstance,projectConfig:project,workspaceId,repoPath:repo.repoPath,path:file.path,changeNoteId:file.changeNoteId,oldPath:file.oldPath,scope:commit?'commit':'compare',commitSha:commit,comparison:commit?undefined:data.comparison,branch:repo.branch,baseSha:data.comparison.leftSha,head:data.comparison.toSha,status:file.status,statusLabel:file.statusLabel},{hostWorkspaceId:props.hostWorkspaceId,agentId:props.agentId,directory:props.directory,panelId:props.agentId?'workspace-workbench-file-agent':'workspace-workbench-file'});
 }
 const filtered=files&&{...files,files:files.files.filter(file=>`${file.path} ${file.oldPath||''}`.toLowerCase().includes(filter.toLowerCase()))};
 return <View ref={root} testID="comparison-sidebar" style={{flex:1,minHeight:0}} onLayout={event=>setWidth(event.nativeEvent.layout.width)}>
   <View testID="comparison-controls">
     <View style={inlineRow}>
       <Pressable accessibilityRole="button" accessibilityLabel="选择比较仓库" onPress={()=>open('repositories')} style={{flex:1,minWidth:0,flexDirection:'row',alignItems:'center',gap:6,minHeight:rowHeight}}><Text numberOfLines={1} style={[label,{fontWeight:'600',flexShrink:1}]}>{repo.name}</Text><Icon name="ChevronDown" size={14} color={theme.colors.foregroundMuted}/></Pressable>
       {error?<IconButton label="比较失败，查看原因与重试" icon="CircleAlert" color={theme.colors.statusWarning} onPress={()=>open('menu')}/>:<IconButton label={pending?'正在计算新比较，仍显示上次结果':'比较模式'} icon="GitCompare" busy={pending} active color={accent} onPress={()=>open('menu')}/>}
       <View style={{flexDirection:'row',alignItems:'center'}}><IconButton label={`比较说明记录 ${catalog.data?.pages[0]?.total??'—'}`} icon="MessageSquare" color={catalog.error?theme.colors.statusWarning:theme.colors.foregroundMuted} onPress={()=>{open('notes');void catalog.refetch();}}/><Text accessibilityElementsHidden style={muted}>{catalog.data?.pages[0]?.total??'—'}</Text></View>
       <IconButton label="返回浏览" icon="ArrowLeft" color={theme.colors.foregroundMuted} onPress={props.onClose}/>
       <IconButton label="比较设置" icon="Ellipsis" color={theme.colors.foregroundMuted} onPress={()=>open('menu')}/>
     </View>
     <View style={[inlineRow,{borderColor:theme.colors.border,borderWidth:1,borderRadius:5}]} accessibilityLabel={applied.mode==='contribution'?'本分支引入的改动':'两端差异'}>
       <Pressable testID="comparison-from" accessibilityRole="button" accessibilityLabel={`选择比较起点：${applied.fromRef||'未选择'}`} onPress={()=>open('from')} style={{flex:1,minWidth:0,paddingHorizontal:8,flexDirection:'row',alignItems:'center',height:rowHeight-2}}><View style={{flex:1,minWidth:0}}><Text numberOfLines={1} style={[label,{fontFamily:'monospace',lineHeight:14}]}>{shortComparisonRef(applied.fromRef)||'选择起点'}</Text>{shownRecord?<Text style={{...muted,fontFamily:'monospace',fontSize:10,lineHeight:12}}>{shownRecord.comparison.fromSha.slice(0,7)}</Text>:null}</View><Icon name="ChevronDown" size={12} color={theme.colors.foregroundMuted}/></Pressable>
       <IconButton label="交换比较起点与终点" icon="ArrowLeftRight" disabled={!applied.fromRef} color={theme.colors.foregroundMuted} onPress={()=>submit(comparisonRequest(applied.toRef,applied.fromRef,applied.mode))}/>
       <Pressable testID="comparison-to" accessibilityRole="button" accessibilityLabel={`选择比较终点：${applied.toRef}`} onPress={()=>open('to')} style={{flex:1,minWidth:0,paddingHorizontal:8,flexDirection:'row',alignItems:'center',height:rowHeight-2}}><View style={{flex:1,minWidth:0}}><Text numberOfLines={1} style={[label,{fontFamily:'monospace',lineHeight:14}]}>{shortComparisonRef(applied.toRef)}</Text>{shownRecord?<Text style={{...muted,fontFamily:'monospace',fontSize:10,lineHeight:12}}>{shownRecord.comparison.toSha.slice(0,7)}</Text>:null}</View><Icon name="ChevronDown" size={12} color={theme.colors.foregroundMuted}/></Pressable>
       {shownRecord?<IconButton label={comparisonRecordState(shownRecord,items,repo.head)==='historical'?'历史比较版本':'固定比较版本'} icon="Clock" color={comparisonRecordState(shownRecord,items,repo.head)==='historical'?theme.colors.statusWarning:theme.colors.foregroundMuted} onPress={()=>open('menu')}/>:null}
       {applied.mode==='contribution'?<Pressable accessibilityRole="button" accessibilityLabel="当前为本分支引入的改动" onPress={()=>open('menu')}><Text style={[muted,{color:accent,paddingRight:4}]}>分支</Text></Pressable>:null}
     </View>
     <View style={[inlineRow,{borderBottomColor:theme.colors.border,borderBottomWidth:1}]}>
       {selectedCommit?<><IconButton label="返回比较结果" icon="ArrowLeft" color={accent} onPress={()=>setSelectedCommit('')}/><Text style={[label,{flex:1}]}>{selectedCommit.slice(0,8)}</Text></>:<View style={{flex:1,minWidth:0,flexDirection:'row',height:rowHeight}}>{(['files','to','from'] as const).map(value=>{
         const text=value==='files'?`文件 ${data?.files.length??'—'}`:`${value==='to'?'当前':'起点'}${width>=380?'独有':''} ${value==='to'?numbers?.toOnly??'—':numbers?.fromOnly??'—'}`;
         return <Pressable key={value} accessibilityRole="tab" accessibilityLabel={value==='files'?'比较文件':value==='to'?'当前独有提交':'起点独有提交'} accessibilityState={{selected:side===value}} onPress={()=>{setSide(value);setOffset(0);}} style={{flex:1,minWidth:0,justifyContent:'center',borderBottomWidth:2,borderBottomColor:side===value?accent:'transparent',paddingHorizontal:2}}><Text numberOfLines={fontScale>1.3?2:1} style={{...label,fontSize:11,color:side===value?theme.colors.foreground:theme.colors.foregroundMuted}}>{text}</Text></Pressable>;
       })}</View>}
       {side==='files'?<NoteFilterButton value={noteFilter} onChange={setNoteFilter} theme={theme}/>:null}
       {side==='files'&&!selectedCommit?<IconButton label={searchOpen?'关闭文件搜索':'搜索变化文件'} icon={searchOpen?'X':'Search'} active={searchOpen} color={theme.colors.foregroundMuted} onPress={()=>{setSearchOpen(value=>!value);setFilter('');}}/>:null}
       {width>=360&&side==='files'&&!selectedCommit?<IconButton label={treeMode==='tree'?'切换平铺列表':'切换目录树'} icon={treeMode==='tree'?'List':'FolderTree'} color={theme.colors.foregroundMuted} onPress={()=>setTreeMode(value=>value==='tree'?'files':'tree')}/>:null}
     </View>
     {searchOpen&&side==='files'&&!selectedCommit?<TextInput accessibilityLabel="搜索变化文件" placeholder="搜索变化文件…" value={filter} onChangeText={setFilter} style={[styles.targetInput,{flex:0,height:rowHeight,minHeight:rowHeight,maxHeight:rowHeight}]}/>:null}
   </View>
   <View testID="comparison-results" style={{flex:1,minHeight:72}} onLayout={event=>setHeight(event.nativeEvent.layout.height)}>
     <View style={side==='files'&&!selectedCommit?{flex:1,minHeight:0}:{display:'none'}}><ChangedTree noteFilter={noteFilter} noteScope={{projectConfig:project,workspaceId,repoPath:repo.repoPath,scope:"compare",comparison:data?.comparison,noteComparisonId:shownRecord?.id}} fill hideHeader changes={filtered||null} loading={!data&&pending} refreshing={false} error={null} stale={false} mode={treeMode} onMode={setTreeMode} scope="branch" selectedCommit="" selectedFile={selected} onSelectFile={file=>openFile(file)} onLayout={()=>{}} sectionLayout={{collapsed:false,height:null}} availableHeight={height} onSectionToggle={()=>{}} onOpenLayoutMenu={()=>open('menu')} theme={theme} styles={styles}/></View>
     <View style={side!=='files'&&!selectedCommit?{flex:1,minHeight:0}:{display:'none'}}><ScrollView style={{flex:1}}>{commits.isFetching&&!history?<ActivityIndicator color={accent}/>:null}{history?.commits?.map(commit=><ComparisonCommitRow key={commit.sha} commit={commit} selected={lastOpenedCommit===commit.sha} onSelect={()=>{setLastOpenedCommit(commit.sha);setSelectedCommit(commit.sha);}} onDetails={()=>{setDetailSha(commit.sha);open('commit-detail');}} theme={theme}/>)}{history&&!history.commits?.length?<Text style={muted}>没有独有提交</Text>:null}<View style={inlineRow}>{(history?.offset||0)>0?menuRow('上一页',()=>setOffset(value=>Math.max(0,value-50)),'ChevronLeft',commits.isFetching):null}{history?.hasMore?menuRow('下一页',()=>setOffset(value=>value+50),'ChevronRight',commits.isFetching):null}</View></ScrollView></View>
     {selectedCommit?<ChangedTree noteFilter={noteFilter} noteScope={{projectConfig:project,workspaceId,repoPath:repo.repoPath,scope:"commit",commitSha:selectedCommit}} key={selectedCommit} fill hideHeader changes={commitData||null} loading={!commitData&&commitFiles.isFetching} refreshing={false} error={null} stale={false} mode={treeMode} onMode={setTreeMode} scope="branch" selectedCommit={selectedCommit} selectedFile={selected} onSelectFile={file=>openFile(file,selectedCommit)} onLayout={()=>{}} sectionLayout={{collapsed:false,height:null}} availableHeight={height} onSectionToggle={()=>{}} onOpenLayoutMenu={()=>open('menu')} theme={theme} styles={styles}/>:null}
   </View>
   {overlay?<ComparisonPopover title={overlay==='notes'?'比较说明':overlay==='commit-detail'?'提交详情':overlay==='menu'?'比较设置':overlay==='repositories'?'选择仓库':overlay==='from'?'选择起点':'选择终点'} theme={theme} anchor={anchor} onClose={()=>setOverlay(null)}>
     {overlay==='notes'?<ComparisonNoteDirectory project={project} workspaceId={workspaceId} repoPath={repo.repoPath} theme={theme} catalog={searchedCatalog} search={noteSearch} onSearch={setNoteSearch} onSelect={selectRecord} requestText={requestText} refs={items} head={repo.head}/>:overlay==='commit-detail'?<><Text selectable style={{color:theme.colors.foreground,fontSize:14,lineHeight:21,marginVertical:8}}>{detailCommit?.subject}</Text><Text selectable style={{...muted,fontFamily:'monospace'}}>{detailSha}</Text>{menuRow('查看此次修改',()=>{setOverlay(null);setLastOpenedCommit(detailSha);setSelectedCommit(detailSha);},'List',!detailCommit)}</>:overlay==='from'||overlay==='to'?<>
       <TextInput autoFocus accessibilityLabel="搜索引用或输入提交 SHA" placeholder="分支、标签或提交 SHA" value={draft} onChangeText={setDraft} onSubmitEditing={()=>choose(draft)} style={[styles.targetInput,{flex:0,height:36,minHeight:36}]}/>
       {menuRow('使用此引用',()=>choose(draft),'Check',!draft.trim())}
       {overlay==='from'&&!production&&suggested?menuRow(`使用并保存 ${suggested.shortName} 为生产分支`,()=>{settings.update({production:{[preferenceKey]:suggested.name}});choose(suggested.name);},'Pin'):null}
       {items.filter(item=>`${item.name} ${item.shortName}`.toLowerCase().includes(draft.toLowerCase())).slice(0,100).map(item=><View key={item.name}>{menuRow(item.shortName,()=>choose(item.name),'GitBranch')}</View>)}
     </>:overlay==='repositories'?props.repositories.map(item=><View key={item.repoPath}>{menuRow(item.name,()=>{setOverlay(null);props.onRepository(item.repoPath);},item.repoPath===repo.repoPath?'Check':'GitBranch')}</View>):<>
       {shownRecord?menuRow('查看最新比较',latestComparison,'RefreshCw'):null}
       {menuRow('比较说明记录',()=>open('notes'),'MessageSquare')}
       {menuRow('复制本次比较的说明请求',()=>{void copyText(requestText).then(()=>setRequestCopy('已复制')).catch(()=>setRequestCopy(requestText));},'Copy',!requestText)}
       {requestCopy?<Text selectable style={muted}>{requestCopy}</Text>:null}
       {menuRow('相对生产分支' ,()=>production?submit(comparisonRequest(production,'HEAD',applied.mode)):open('from'),'GitBranch')}
       {menuRow('相对创建基线',()=>submit(comparisonRequest(repo.baseSha||'','HEAD',applied.mode)),'GitBranch',!repo.baseSha)}
       {menuRow('自定义比较',()=>open('from'),'GitCompare')}
       {menuRow('两端差异',()=>submit(comparisonRequest(applied.fromRef,applied.toRef,'endpoints')),applied.mode==='endpoints'?'Check':undefined)}
       {menuRow('本分支引入的改动',()=>submit(comparisonRequest(applied.fromRef,applied.toRef,'contribution')),applied.mode==='contribution'?'Check':undefined)}
       {menuRow('将起点保存为生产分支',()=>settings.update({production:{[preferenceKey]:applied.fromRef}}),'Pin',!items.some(item=>item.kind==='remote'&&(item.name===applied.fromRef||item.shortName===applied.fromRef)))}
       {menuRow('获取所选远端分支更新',()=>{setFetchError('');void rpc({method:'repository.fetch',params:{workspaceId,repoPath:repo.repoPath,ref:applied.fromRef,requestId:`fetch:${Date.now()}:${Math.random()}`}}).then(value=>{if(!value.ok)setFetchError(value.error?.message||'获取失败');void refs.refetch({cancelRefetch:false});}).catch(()=>{setFetchError('响应未确认，请核对状态');void refs.refetch({cancelRefetch:false});});},'RefreshCw',fetchState?.state==='running'||!items.some(item=>item.kind==='remote'&&(item.name===applied.fromRef||item.shortName===applied.fromRef)))}
       {menuRow(treeMode==='tree'?'使用平铺文件列表':'使用目录树',()=>setTreeMode(value=>value==='tree'?'files':'tree'),treeMode==='tree'?'List':'FolderTree')}
       <Text selectable style={muted}>{`当前显示：${applied.fromRef||'未选择'} → ${applied.toRef}\n${data?`${data.comparison.fromSha}\n${data.comparison.toSha}\n实际起点：${data.comparison.leftSha}`:''}`}</Text>
       {pending||continuity.retained?<Text selectable style={muted}>{`请求范围：${request?.fromRef} → ${request?.toRef}`}</Text>:null}
       <Text style={muted}>{fetchState?.state==='running'?'正在获取远端更新':fetchState?.lastFetchedAt?`最近获取 ${fetchState.ref}：${fetchState.lastFetchedAt}`:'获取时间未知'}</Text>
       {request?.record&&error?menuRow('查看已保存的说明与原始补丁',()=>open('notes'),'MessageSquare'):null}
       {error?<><Text selectable style={{...muted,color:theme.colors.statusWarning}}>{error}</Text>{menuRow('重试当前读取',()=>{void fileQuery.refetch({cancelRefetch:false});if(selectedCommit)void commitFiles.refetch({cancelRefetch:false});if(side!=='files')void commits.refetch({cancelRefetch:false});},'RefreshCw')}</>:null}
     </>}
   </ComparisonPopover>:null}
 </View>;
}
