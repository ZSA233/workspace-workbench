import {useEffect,useState} from 'react';
import {ActivityIndicator,Pressable,Text,View} from 'react-native';
import {Icon,ScrollView} from './native-components';
import {Button,Dialog,Label,Row,Search,useColors} from './extensions/project-communications/ui';
import type {OrganizerInput,SessionAssociations} from '../shared/organizer';
import {organizerErrorLabel} from './organizer-errors';

type Props={targetId:string;title:string;currentWorkspace:{id:string;instanceKey?:string};call<T>(request:OrganizerInput['request']):Promise<T>;onClose():void;onSaved():void};
export function SessionAssociationsDialog({targetId,title,currentWorkspace,call,onClose,onSaved}:Props){
  const c=useColors(),[data,setData]=useState<SessionAssociations>(),[selected,setSelected]=useState<Set<string>>(new Set()),[search,setSearch]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[attempt,setAttempt]=useState(0),[chooseOther,setChooseOther]=useState(false);
  useEffect(()=>{let alive=true;setLoading(true);setError('');void call<SessionAssociations>({action:'session.associations',targetId}).then(value=>{if(alive){setData(value);setSelected(new Set(value.workspaces.filter(row=>row.linked).map(row=>row.key)));}}).catch(e=>{if(alive)setError(e.message);}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};},[targetId,call,attempt]);
  const original=data?.workspaces.filter(row=>row.linked).map(row=>row.key)||[],changed=original.length!==selected.size||original.some(key=>!selected.has(key)),query=search.trim().toLocaleLowerCase();
  const rows=(data?.workspaces||[]).filter(row=>!query||[row.name,row.id,row.title].some(value=>value?.toLocaleLowerCase().includes(query)));
  const current=data?.workspaces.find(row=>row.id===currentWorkspace.id&&row.key===currentWorkspace.instanceKey),suggestion=!!current&&!chooseOther;
  const close=()=>{if(!saving)onClose();};
  const save=(keys:string[])=>{if(!data)return;setSaving(true);setError('');void call<SessionAssociations>({action:'session.associations.save',targetId,revision:data.revision,workspaceKeys:keys}).then(onSaved).catch(e=>setError(e.message)).finally(()=>setSaving(false));};
  return <Dialog id="session-associations" title="关联工作区" compact width={420} height={620} onClose={close} footer={<Row end>{!suggestion&&!loading?<Label muted>已选 {selected.size}</Label>:null}<Button disabled={saving} onPress={close}>取消</Button><Button id="session-save-associations" variant="primary" disabled={loading||saving||!data||!suggestion&&!changed} onPress={()=>{if(suggestion){if(current.linked)close();else save([...new Set([...selected,current.key])]);}else save([...selected]);}}>{saving?'保存中…':suggestion?current.linked?'完成':'确认关联':'保存关联'}</Button></Row>}>
    {loading?<View style={{padding:20}}><ActivityIndicator color={c.accent}/></View>:suggestion?<View testID="session-association-current" style={{padding:16,gap:11}}>
      <Label muted>当前工作区</Label><View style={{borderWidth:1,borderColor:c.border,borderRadius:5,padding:12,gap:5}}>{current.title?<Label strong>{current.title}</Label>:null}<Text numberOfLines={3} style={{fontSize:current.title?12:14,lineHeight:21,color:current.title?c.foregroundMuted:c.foreground}}>{current.name}</Text>{current.linked?<Row><Icon name="Check" size={14} color={c.statusSuccess}/><Text style={{fontSize:12,color:c.statusSuccess}}>已关联</Text></Row>:null}</View>
      <View style={{alignSelf:'center'}}><Icon name="ArrowDown" size={17} color={c.foregroundMuted}/></View><Label muted>当前会话</Label><Label lines={2}>{data?.title||title||'当前会话'}</Label><View style={{alignSelf:'flex-start'}}><Button icon="List" variant="link" disabled={saving} onPress={()=>setChooseOther(true)}>选择其他工作区</Button></View>
    </View>:<><View style={{paddingHorizontal:16,paddingTop:12,paddingBottom:10,gap:9}}><Label lines={2}>{data?.title||title||'当前会话'}</Label><Search value={search} onChange={setSearch} placeholder="搜索工作区"/></View>
    <ScrollView style={{flexGrow:0,flexShrink:1,minHeight:0}} contentContainerStyle={{paddingBottom:6}}>
      {rows.map(row=>{const checked=selected.has(row.key);return <Pressable key={row.key} testID={'session-associate-'+row.id} accessibilityRole="checkbox" accessibilityLabel={row.name} aria-checked={checked} accessibilityState={{checked,disabled:saving}} disabled={saving} onPress={()=>setSelected(old=>{const next=new Set(old);if(next.has(row.key))next.delete(row.key);else next.add(row.key);return next;})} style={({hovered,pressed}:any)=>({paddingHorizontal:16,paddingVertical:10,flexDirection:'row',alignItems:'center',gap:10,backgroundColor:hovered||pressed?c.surface2:c.surface0,borderTopWidth:1,borderTopColor:c.border})}>
        <Icon name={checked?'SquareCheck':'Square'} size={17} color={checked?c.accent:c.foregroundMuted}/><View style={{flex:1,minWidth:0,gap:3}}>{row.title?<Text numberOfLines={1} style={{fontSize:13,color:c.foreground}}>{row.title}</Text>:null}<Text numberOfLines={2} style={{fontSize:row.title?11:13,lineHeight:19,color:row.title?c.foregroundMuted:c.foreground}}>{row.name}</Text></View>{row.linked?<Label muted>{row.source==='manual'?'手动关联':'自动关联'}</Label>:null}
      </Pressable>;})}
      {!loading&&!rows.length?<View style={{padding:16}}><Label muted>{data?.workspaces.length?'没有匹配的工作区':'此项目暂无可关联的工作区'}</Label></View>:null}
    </ScrollView></>}
    {error?<View style={{padding:12,gap:6}}><Label warning>{organizerErrorLabel(error)}</Label><Button variant="link" onPress={()=>setAttempt(value=>value+1)}>重新读取</Button></View>:null}
  </Dialog>;
}
