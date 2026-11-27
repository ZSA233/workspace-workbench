import {useEffect,useState} from 'react';
import {ActivityIndicator,Pressable,Text,View} from 'react-native';
import {Icon,ScrollView} from './native-components';
import {Button,Dialog,Label,Row,Search,useColors} from './extensions/project-communications/ui';
import type {OrganizerInput,SessionAssociations} from '../shared/organizer';
import {organizerErrorLabel} from './organizer-errors';

type Props={targetId:string;title:string;call<T>(request:OrganizerInput['request']):Promise<T>;onClose():void;onSaved():void};
export function SessionAssociationsDialog({targetId,title,call,onClose,onSaved}:Props){
  const c=useColors(),[data,setData]=useState<SessionAssociations>(),[selected,setSelected]=useState<Set<string>>(new Set()),[search,setSearch]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[attempt,setAttempt]=useState(0);
  useEffect(()=>{let alive=true;setLoading(true);setError('');void call<SessionAssociations>({action:'session.associations',targetId}).then(value=>{if(alive){setData(value);setSelected(new Set(value.workspaces.filter(row=>row.linked).map(row=>row.key)));}}).catch(e=>{if(alive)setError(e.message);}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};},[targetId,call,attempt]);
  const original=data?.workspaces.filter(row=>row.linked).map(row=>row.key)||[],changed=original.length!==selected.size||original.some(key=>!selected.has(key)),query=search.trim().toLocaleLowerCase();
  const rows=(data?.workspaces||[]).filter(row=>!query||[row.name,row.id,row.title].some(value=>value?.toLocaleLowerCase().includes(query)));
  const close=()=>{if(!saving)onClose();};
  return <Dialog id="session-associations" title="关联工作区" compact width={420} height={620} onClose={close} footer={<Row end><Label muted>已选 {selected.size}</Label><Button disabled={saving} onPress={close}>取消</Button><Button id="session-save-associations" variant="primary" disabled={loading||saving||!data||!changed} onPress={()=>{if(!data)return;setSaving(true);setError('');void call<SessionAssociations>({action:'session.associations.save',targetId,revision:data.revision,workspaceKeys:[...selected]}).then(onSaved).catch(e=>setError(e.message)).finally(()=>setSaving(false));}}>{saving?'保存中…':'保存关联'}</Button></Row>}>
    <View style={{paddingHorizontal:16,paddingTop:12,paddingBottom:10,gap:9}}><Label lines={2}>{title||'当前会话'}</Label><Search value={search} onChange={setSearch} placeholder="搜索工作区"/></View>
    <ScrollView style={{flexGrow:0,flexShrink:1,minHeight:0}} contentContainerStyle={{paddingBottom:6}}>
      {loading?<View style={{padding:20}}><ActivityIndicator color={c.accent}/></View>:rows.map(row=>{const checked=selected.has(row.key);return <Pressable key={row.key} testID={'session-associate-'+row.id} accessibilityRole="checkbox" accessibilityLabel={row.name} aria-checked={checked} accessibilityState={{checked,disabled:saving}} disabled={saving} onPress={()=>setSelected(old=>{const next=new Set(old);if(next.has(row.key))next.delete(row.key);else next.add(row.key);return next;})} style={({hovered,pressed}:any)=>({paddingHorizontal:16,paddingVertical:10,flexDirection:'row',alignItems:'center',gap:10,backgroundColor:hovered||pressed?c.surface2:c.surface0,borderTopWidth:1,borderTopColor:c.border})}>
        <Icon name={checked?'SquareCheck':'Square'} size={17} color={checked?c.accent:c.foregroundMuted}/><View style={{flex:1,minWidth:0,gap:3}}>{row.title?<Text numberOfLines={1} style={{fontSize:13,color:c.foreground}}>{row.title}</Text>:null}<Text numberOfLines={2} style={{fontSize:row.title?11:13,lineHeight:19,color:row.title?c.foregroundMuted:c.foreground}}>{row.name}</Text></View>{row.linked?<Label muted>{row.source==='manual'?'手动关联':'自动关联'}</Label>:null}
      </Pressable>;})}
      {!loading&&!rows.length?<View style={{padding:16}}><Label muted>{data?.workspaces.length?'没有匹配的工作区':'此项目暂无可关联的工作区'}</Label></View>:null}
    </ScrollView>
    {error?<View style={{padding:12,gap:6}}><Label warning>{organizerErrorLabel(error)}</Label><Button variant="link" onPress={()=>setAttempt(value=>value+1)}>重新读取</Button></View>:null}
  </Dialog>;
}
