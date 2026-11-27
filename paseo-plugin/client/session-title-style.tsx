import {Text,View} from 'react-native';
import {Button,Field,Label,Row,Section,useColors} from './extensions/project-communications/ui';
import {defaultMarkers,productionLabels,type OrganizerPolicy} from '../shared/organizer';

const states=['deployed','pending'] as const;
const presets=[
 {id:'simple',label:'简洁符号',markers:{deployed:defaultMarkers.deployed,pending:defaultMarkers.pending}},
 {id:'color',label:'彩色 emoji',markers:{deployed:'🟢',pending:'🔴'}},
 {id:'text',label:'短文字',markers:{deployed:'【已上线】',pending:'【未上线】'}},
];
type Markers=OrganizerPolicy['markers'];
export function SessionTitleStyle({markers,onChange}:{markers:Markers;onChange(value:Markers):void}){
 const c=useColors();
 return <View testID="session-title-style" style={{gap:9}}>
  <Label strong>标题样式</Label>
  <Row>{presets.map(p=><Button key={p.id} id={'session-title-style-'+p.id} active={states.every(s=>markers[s]===p.markers[s])} onPress={()=>onChange({...markers,...p.markers})}>{p.label}</Button>)}</Row>
  <View testID="session-title-style-preview" style={{gap:8,padding:10,borderWidth:1,borderColor:c.border,borderRadius:6}}>
   {states.map(s=><View key={s} style={{flexDirection:'row',alignItems:'center',gap:10}}>
    <Text style={{width:84,fontSize:12,color:c.foregroundMuted}}>{productionLabels[s]}</Text>
    <Text testID={'session-title-style-preview-'+s} numberOfLines={1} style={{flex:1,minWidth:0,fontSize:13,color:c.foreground}}>{[markers[s].replace(/[\u0000-\u001f\u007f]/g,'').trim(),'关系迁移与退款'].filter(Boolean).join(' ')}</Text>
   </View>)}
   <View style={{flexDirection:'row',alignItems:'center',gap:10}}><Text style={{width:84,fontSize:12,color:c.foregroundMuted}}>有未提交改动</Text><Text testID="session-title-style-preview-working" numberOfLines={1} style={{flex:1,minWidth:0,fontSize:13,color:c.foreground}}>{markers.deployed} ✎ 关系迁移与退款</Text></View>
  </View>
  <Section title="自定义符号" collapsible initiallyOpen={false}>
   {states.map(s=><Field key={s} id={'session-title-marker-'+s} label={productionLabels[s]} value={markers[s]} placeholder="留空隐藏" onChange={value=>onChange({...markers,[s]:value})}/>)}
  </Section>
 </View>;
}
