import {useState,useRef} from 'react';
import {Pressable,Text,View} from 'react-native';
import {IconButton} from './icon-button';
import {ComparisonPopover} from './comparison-popover';
import {useWorkbenchLocale} from '../i18n';
import type {PluginWorkspacePanelProps} from '@getpaseo/plugin/client';
export type NoteFilter='all'|'has'|'none'|'pending'|'stale';
export function NoteFilterButton({value,onChange,theme}:{value:NoteFilter;onChange(value:NoteFilter):void;theme:PluginWorkspacePanelProps['theme']}){
 const root=useRef<any>(null),[anchor,setAnchor]=useState({x:0,y:0,width:320,height:30});
 const [open,setOpen]=useState(false),zh=useWorkbenchLocale()==='zh-CN';
 const labels:Record<NoteFilter,string>=zh?{all:'全部改动',has:'有说明',none:'无说明',pending:'待确认',stale:'待更新'}:{all:'All changes',has:'With explanations',none:'Without explanations',pending:'Needs confirmation',stale:'Needs update'};
 return <><View ref={root}><IconButton icon="MessageSquare" label={`${zh?'说明筛选':'Explanation filter'}: ${labels[value]}`} color={theme.colors.foregroundMuted} active={value!=='all'} onPress={()=>{root.current?.measureInWindow?.((x:number,y:number,width:number,height:number)=>setAnchor({x,y,width,height}));setOpen(true);}}/></View>{open?<ComparisonPopover title={zh?'说明筛选':'Explanation filter'} theme={theme} anchor={anchor} onClose={()=>setOpen(false)}>{(Object.keys(labels) as NoteFilter[]).map(key=><Pressable key={key} accessibilityRole="button" onPress={()=>{onChange(key);setOpen(false);}} style={{padding:10}}><Text style={{color:theme.colors.foreground}}>{labels[key]}</Text></Pressable>)}</ComparisonPopover>:null}</>;
}
