import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {View,Text,Pressable,Platform} from 'react-native';
import {useRpc,type PluginWorkspacePanelProps,type PluginAgentPanelProps} from '@getpaseo/plugin/client';
import {useQuery} from '@tanstack/react-query';
import {projectBackendStatus} from '../shared/setup';
import {languageForPath} from '../shared/code-syntax';
import {filesRpc} from '../shared/file-rpc';
import {FlatList,ScrollView,TextInput,copyText} from './native-components';
import {useWorkbenchLocale} from './i18n';
import {usePanelForeground} from './foreground-activity';
import {useDisplaySettings} from './use-display-settings';
import {useFileConnection,FileTransfers,fileBytes} from './files-transfer-panel';
import {createDocumentReader} from './document-reader';
import {DocumentMarkdown} from './document-markdown';
import {HighlightedCode,editorCodeFontFamily} from './syntax';
import {activateDocument,backToFiles,closeDocument,documentKey,openDocument,useActiveDocument,useDocuments,type DocumentSelection} from './document-store';
type Props=PluginWorkspacePanelProps|PluginAgentPanelProps;
export function DocumentPanel(props:Props){
  const selections=useDocuments(props.workspaceId),key=useActiveDocument(props.workspaceId),selection=selections.find(s=>documentKey(s)===key)||selections.at(-1),c=props.theme.colors;
  const last=useRef<DocumentSelection|undefined>(undefined);if(selection)last.current=selection;
  return <View testID="workbench-document-panel" style={{flex:1,minHeight:0,backgroundColor:c.surface0}}>
    <ScrollView horizontal style={{flexGrow:0,borderBottomWidth:1,borderColor:c.border}}>{selections.map(s=><View key={documentKey(s)} style={{flexDirection:'row',alignItems:'center',backgroundColor:s===selection?c.surface2:c.surface0}}><Pressable accessibilityRole="tab" accessibilityState={{selected:s===selection}} onPress={()=>activateDocument(s)} style={{padding:9}}><Text style={{color:c.foreground,fontSize:12}}>{s.path.split('/').at(-1)}</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel={`Close ${s.path}`} onPress={()=>closeDocument(s)} style={{padding:8}}><Text style={{color:c.foregroundMuted}}>×</Text></Pressable></View>)}</ScrollView>
    {selection?<DocumentBody key={documentKey(selection)} {...props} selection={selection}/>:<View style={{padding:16,gap:12}}><Text style={{color:c.foregroundMuted}}>Select a file in Workspace Workbench → Files.</Text>{last.current?<Pressable accessibilityRole="button" onPress={()=>backToFiles(last.current!)}><Text style={{color:c.accent}}>← Back to files</Text></Pressable>:null}</View>}
  </View>;
}
function DocumentBody({selection:s,...props}:Props&{selection:DocumentSelection}){
  const zh=useWorkbenchLocale()==='zh-CN',c=props.theme.colors,activity=usePanelForeground(),display=useDisplaySettings();
  const backend=useRpc(projectBackendStatus),rpc=useRpc(filesRpc),rpcRef=useRef(rpc);rpcRef.current=rpc;
  const call=useCallback(async(request:Record<string,unknown>)=>{const result=await rpcRef.current({projectConfig:s.projectConfig,request:request as any});if(!result.ok){const error=Object.assign(new Error(result.error?.message||'Read failed'),{code:result.error?.code});throw error;}return result.result as any;},[s.projectConfig]);
  const status=useQuery({queryKey:['document-backend',s.projectConfig],queryFn:()=>backend({projectConfig:s.projectConfig}),staleTime:1000});
  const ready=status.data?.state==='ready',capable=status.data?.readCapabilities?.documentPreviewProtocol===1;
  const transfers=useFileConnection(s.projectConfig,s.scope,ready,status.data?.readCapabilities?.downloadSelectionProtocol===1);
  const reader=useMemo(()=>createDocumentReader(s.scope+'\0'+documentKey(s),s,call),[s.scope,s.workspaceId,s.instance,s.path,call]);
  const state=useSyncExternalStore(reader.subscribe,reader.snapshot),[error,setError]=useState(''),[search,setSearch]=useState(''),[match,setMatch]=useState(0),[visible,setVisible]=useState(0),[width,setWidth]=useState(800);
  const md=languageForPath(s.path)==='markdown',mode=state.mode||(md?'preview':'source'),list=useRef<any>(null);
  const lines=useMemo(()=>state.text.split(/\r\n|\r|\n/),[state.text]);
  const maxLength=useMemo(()=>lines.reduce((max,line)=>Math.max(max,line.length),0),[lines]),longLine=maxLength>12000,wrap=display.wrap||longLine;
  const matches=useMemo(()=>{if(!search)return [];const q=search.toLocaleLowerCase();return lines.flatMap((code,i)=>code.toLocaleLowerCase().includes(q)?[i]:[]);},[lines,search]);
  const run=(work:()=>Promise<unknown>)=>{setError('');void work().catch(reason=>setError(String(reason.message||reason)));};
  useEffect(()=>()=>reader.close(),[reader]);
  useEffect(()=>{if(ready&&capable)void reader.load();},[reader,ready,capable]);
  useEffect(()=>{if(!ready||!capable||!activity.foreground)return;const timer=setInterval(()=>void reader.validate(),5000);return()=>clearInterval(timer);},[reader,ready,capable,activity.foreground]);
  const windowStart=state.startLine+Math.floor(visible/120)*120;
  useEffect(()=>{if(state.page&&!state.page.binary&&activity.foreground)void reader.highlight(windowStart,md&&mode==='preview');},[reader,state.page?.version,state.revision,windowStart,md,mode,activity.foreground]);
  useLayoutEffect(()=>{if(state.page&&list.current){list.current.scrollToOffset?.({offset:state.scroll,animated:false});setVisible(Math.max(0,Math.floor(state.scroll/(display.fontSize+8))));}},[state.page?.version,state.revision,state.windowOffset,mode]);
  const imageBudget=useMemo(()=>({bytes:0,versions:new Map<string,string>()}),[reader,state.page?.version]);
  const asset=useCallback(async(path:string,offset:number,version?:string)=>{const value=await call({action:'document-asset',workspaceId:s.workspaceId,instance:s.instance,path,offset,version});if(imageBudget.versions.get(path)!==value.version){if(imageBudget.bytes+value.size>8*1024*1024)throw Error(zh?'内嵌图片总量超过 8 MiB，请单独打开或下载。':'Inline images exceed the 8 MiB preview budget. Open or download the file.');imageBudget.bytes+=value.size;imageBudget.versions.set(path,value.version);}return value;},[call,s,imageBudget,zh]);
  const button=(label:string,press:()=>void,disabled=false)=><Pressable key={label} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={press} style={{paddingHorizontal:9,paddingVertical:7,opacity:disabled?.4:1}}><Text style={{color:c.foreground,fontSize:12}}>{label}</Text></Pressable>;
  const lineHeight=display.fontSize+8;
  const renderLine=({item:code,index}:{item:string;index:number})=><View testID="document-code-line" style={{flexDirection:'row',minHeight:lineHeight,backgroundColor:search&&code.toLocaleLowerCase().includes(search.toLocaleLowerCase())?c.surface2:undefined}}><Text selectable={false} style={{width:64,textAlign:'right',paddingRight:12,color:c.foregroundMuted,fontFamily:editorCodeFontFamily,fontSize:11,lineHeight}}>{state.startLine+index}</Text><HighlightedCode code={code||' '} path={s.path} spans={state.tokens[String(state.startLine+index)]?.code===code?state.tokens[String(state.startLine+index)].spans:null} theme={props.theme} style={{fontSize:display.fontSize,lineHeight,...(wrap?{flex:1}:{flexShrink:0}),...(Platform.OS==='web'?{whiteSpace:wrap?'pre-wrap':'pre',overflowWrap:'anywhere',tabSize:4} as any:{})}}/></View>;
  const source=<FlatList testID="document-source-lines" ref={list} style={{flex:1,minHeight:0}} data={lines} keyExtractor={(_,i)=>String(state.startLine+i)} renderItem={renderLine} initialNumToRender={50} maxToRenderPerBatch={35} windowSize={7} getItemLayout={wrap?undefined:(_,i)=>({length:lineHeight,offset:i*lineHeight,index:i})} onScroll={event=>{const offset=event.nativeEvent.contentOffset.y;reader.setView({scroll:offset});if(!wrap)setVisible(Math.max(0,Math.floor(offset/lineHeight)));}} onViewableItemsChanged={useRef(({viewableItems}:any)=>{const first=viewableItems.find((item:any)=>item.index!=null);if(first)setVisible(first.index);}).current} scrollEventThrottle={120} onScrollToIndexFailed={({index})=>list.current?.scrollToOffset?.({offset:index*lineHeight,animated:false})}/>;
  return <View ref={activity.ref} style={{flex:1,minHeight:0}} onLayout={event=>setWidth(event.nativeEvent.layout.width)}>
    <View style={{borderBottomWidth:1,borderColor:c.border,paddingHorizontal:8,paddingVertical:5,gap:3}}><Text selectable style={{color:c.foreground,fontSize:12}}>{s.path}</Text><Text selectable style={{color:c.foregroundMuted,fontSize:11}}>{s.workspaceName} · {state.page?fileBytes(state.page.size):'…'} · {state.page?.encoding||''}</Text></View>
    <View style={{flexDirection:'row',flexWrap:'wrap',alignItems:'center',borderBottomWidth:1,borderColor:c.border}}>
      {button(zh?'返回文件':'Back to files',()=>backToFiles(s))}
      {md?button(mode==='preview'?(zh?'源码':'Source'):(zh?'预览':'Preview'),()=>{reader.setView({mode:mode==='preview'?'source':'preview'});}):null}
      {button(zh?'刷新':'Refresh',()=>run(()=>reader.load(true)),state.loading)}
      {button(wrap?(zh?'不换行':'No wrap'):(zh?'自动换行':'Wrap'),()=>display.update({wrap:!display.wrap}),longLine)}
      {button('A−',()=>display.update({fontSize:Math.max(12,display.fontSize-2)}),display.fontSize<=12)}
      {button('A+',()=>display.update({fontSize:Math.min(18,display.fontSize+2)}),display.fontSize>=18)}
      {button(zh?'复制已加载源码':'Copy loaded source',()=>run(()=>copyText(state.text)),!state.page||state.page.binary)}
      {button(zh?'复制路径':'Copy path',()=>run(()=>copyText(s.path)))}
      {button(zh?'下载':'Download',()=>run(()=>transfers.download(s.workspaceId,s.instance,[s.path],s.path.split('/').at(-1)!,state.page?{[s.path]:state.page.version}:undefined)),!ready||!state.page||state.changed)}
    </View>
    {mode==='source'?<View style={{flexDirection:'row',alignItems:'center',gap:8,padding:6}}><TextInput value={search} onChangeText={value=>{setSearch(value);setMatch(0);}} placeholder={zh?'搜索已加载源码':'Find in loaded source'} style={{flex:1,color:c.foreground,fontSize:12,borderWidth:1,borderColor:c.border,padding:5}}/>{button(`${matches.length?match%matches.length+1:0}/${matches.length} ↓`,()=>{if(matches.length){list.current?.scrollToIndex?.({index:matches[match%matches.length],animated:false});setMatch(v=>v+1);}},!matches.length)}</View>:null}
    {error||state.error||state.changed?<Text selectable style={{padding:8,color:c.statusWarning,fontSize:12}}>{state.changed?(zh?'文件已变化，请刷新查看新版本。':'File changed. Refresh to read the new version.'):error||state.error}</Text>:null}
    {!ready||!capable?<Text style={{padding:12,color:c.foregroundMuted}}>{status.data?.message||(!capable&&ready?'Update the backend to enable the file viewer.':'Loading…')}</Text>:!state.page?<Text style={{padding:12,color:c.foregroundMuted}}>{state.error?(zh?'暂时无法读取文件，请重试。':'Unable to read this file. Refresh to retry.'):'Loading…'}</Text>:state.page.binary?<Text style={{padding:16,color:c.foregroundMuted}}>{zh?'二进制文件，请使用下载。':'Binary file. Use Download.'}</Text>:mode==='preview'&&state.markdown?<ScrollView style={{flex:1}}><DocumentMarkdown nodes={state.markdown} path={s.path} theme={props.theme} fontSize={display.fontSize} asset={asset} open={path=>openDocument({...s,path})}/></ScrollView>:<>
      {mode==='preview'?<Text style={{padding:8,color:c.foregroundMuted,fontSize:12}}>{state.syntaxState==='plain'?(zh?'此文件使用源码模式。':'Source mode for this file.'):(zh?'正在生成 Markdown 预览…':'Rendering Markdown…')}</Text>:null}
      {wrap?source:<ScrollView horizontal style={{flex:1}} contentContainerStyle={{width:Math.max(width,maxLength*display.fontSize*.62+80),flex:1}}>{source}</ScrollView>}
    </>}
    {state.page&&(state.windowIndex>0||!state.page.eof)&&!(mode==='preview'&&state.markdown)?<View style={{flexDirection:'row',flexWrap:'wrap',alignItems:'center',borderTopWidth:1,borderColor:c.border}}>{state.windowIndex>0?button(zh?'上一段':'Previous section',()=>run(()=>reader.previous()),state.loading):null}{!state.page.eof?button(state.loading?'Loading…':zh?'加载后续内容':'Load more',()=>run(()=>reader.more()),state.loading):null}<Text style={{color:c.foregroundMuted,fontSize:11}}>{zh?'已读取':'Read'} {fileBytes(state.page.nextOffset)} / {fileBytes(state.page.size)}</Text></View>:null}
    {mode==='source'&&state.page&&(!state.page.eof||state.windowOffset>0)?<Text style={{padding:4,color:c.foregroundMuted,fontSize:11}}>{zh?`搜索范围：已加载的第 ${state.startLine}–${state.startLine+lines.length-1} 行。`:`Search covers loaded lines ${state.startLine}–${state.startLine+lines.length-1}.`}</Text>:null}
    {state.continuation||longLine?<Text style={{padding:4,color:c.foregroundMuted,fontSize:11}}>{state.continuation?(zh?`从第 ${state.startLine} 行的中间继续；前一段包含开头。`:`Continuing line ${state.startLine}; its beginning is in the previous section.`):(zh?'超长行自动换行显示。':'Very long lines are wrapped.')}</Text>:null}
    {state.reason?<Text style={{padding:4,color:c.foregroundMuted,fontSize:11}}>{['large_file','syntax_budget'].includes(state.reason)?(zh?'大文件模式：分段显示源码。':'Large file mode: paged source.'):state.reason==='markdown_preview_limit'?(zh?'文档排版超过预览预算，已切换为分段源码。':'Preview budget exceeded. Showing paged source.'):state.reason==='unknown_language'?(zh?'此类型使用纯文本显示。':'Plain text for this file type.'):(zh?'语法高亮暂不可用，源码仍可阅读。':'Highlighting is unavailable; source remains readable.')}</Text>:null}
    <FileTransfers store={transfers} theme={props.theme}/>
  </View>;
}
