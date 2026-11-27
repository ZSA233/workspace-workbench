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
   {w.material.repositories.map(repo=><View key={repo.repositoryId} style={{gap:5,paddingVertical:8,borderBottomWidth:1,borderBottomColor:c.border}}>
    <Row><Label strong>{repo.repositoryId}</Label><Text style={{fontSize:12,color:repo.state==='deployed'?c.statusSuccess:repo.state==='unknown'?c.statusWarning:c.foregroundMuted}}>{repo.state==='unknown'?'上线待核实':productionLabels[repo.state]}</Text></Row>
    <Label muted lines={2}>{repo.productionRef||'未配置生产分支'}</Label>
    <Label muted>已覆盖 {repo.covered} · 未覆盖 {repo.pending} · 待核实 {repo.uncertain}{repo.dirty?' · 有未提交改动':''}</Label>
    {repo.reason?<Label warning>{reason(repo.reason)}</Label>:null}
    <Label muted>{new Date(repo.observedAt).toLocaleString()}</Label>
   </View>)}
  </View>)}</ScrollView>
 </Dialog>;
}
