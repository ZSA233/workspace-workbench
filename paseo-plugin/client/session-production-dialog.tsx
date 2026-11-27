import {View,Text} from 'react-native';
import {ScrollView} from './native-components';
import {Button,Dialog,Label,Row,useColors} from './extensions/project-communications/ui';
import {productionLabels,type WorkspaceAnalysis} from '../shared/organizer';

export function SessionProductionDialog({workspaces,onClose}:{workspaces:WorkspaceAnalysis[];onClose():void}){
 const c=useColors();
 const reason=(value:string)=>value==='git output exceeded limit'?'改动较大，Git 结果超出读取上限':value;
 return <Dialog id="session-production-evidence" title="Git 上线依据" compact width={460} height={600} onClose={onClose} footer={<Row end><Button onPress={onClose}>关闭</Button></Row>}>
  <ScrollView contentContainerStyle={{padding:16,gap:14}}>{workspaces.map(w=><View key={w.key} style={{gap:9}}>
   <Label strong>{w.digest?.title||w.material.name}</Label>
   {w.material.repositories.map(repo=>{const state=repo.referenceUnavailable?'unknown':repo.committedState||repo.state;return <View key={repo.repositoryId} style={{gap:5,paddingVertical:8,borderBottomWidth:1,borderBottomColor:c.border}}>
    <Row><Label strong>{repo.repositoryId}</Label><Text style={{fontSize:12,color:state==='deployed'?c.statusSuccess:state==='unknown'?c.statusWarning:c.foregroundMuted}}>{productionLabels[state]}</Text></Row>
    <Label muted lines={2}>{repo.productionRef||'未配置生产分支'}</Label>
    <Label muted>已覆盖 {repo.covered} · 未覆盖 {Math.max(0,repo.pending-(repo.dirty?1:0))} · 待核实 {repo.uncertain}{repo.dirty?' · 有未提交改动':''}</Label>
    {repo.reason?<Label warning>{reason(repo.reason)}</Label>:null}
    <Label muted>{new Date(repo.observedAt).toLocaleString()}</Label>
   </View>;})}
  </View>)}</ScrollView>
 </Dialog>;
}
