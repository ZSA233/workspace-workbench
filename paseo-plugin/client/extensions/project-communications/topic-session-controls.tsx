import {useEffect,useState} from 'react';
import {ActivityIndicator,Pressable,Text,View} from 'react-native';
import type {TopicModel,TopicNewSession} from '../../../shared/extensions/project-communications/topics';
import {topicEffortLabel,topicModelChoice,topicModelKey,topicProviderLabel} from '../../topic-session-choice';
import {Icon,ScrollView} from '../../native-components';
import {Button,Choice,Dialog,Label,Search,tint,useColors,useTouch} from './ui';
import {TopicIcon} from './topic-ui';

function Option({id,label,icon,selected,count,nested,onPress}:{id?:string;label:string;icon:string;selected:boolean;count?:number;nested?:boolean;onPress():void}){
  const c=useColors(),touch=useTouch();
  return <Pressable testID={id} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{selected}} onPress={onPress}
    style={({hovered}:any)=>({minHeight:touch?48:40,flexDirection:'row',alignItems:'center',gap:10,paddingHorizontal:12,paddingVertical:8,
      borderRadius:6,backgroundColor:selected?tint(c.accent):hovered?c.surface2:undefined})}>
    <Icon name={icon} size={16} color={selected?c.accent:c.foregroundMuted}/>
    <Text numberOfLines={1} style={{flex:1,minWidth:0,fontSize:13,color:selected?c.accent:c.foreground}}>{label}</Text>
    {count!==undefined?<Label muted>{count}</Label>:null}
    {nested?<Icon name="ChevronRight" size={15} color={c.foregroundMuted}/>:selected?<Icon name="Check" size={15} color={c.accent}/>:null}
  </Pressable>;
}

export function TopicSessionControls({models,choice,locked,loading,refreshing,unavailable,onRefresh,onChange}:{
  models:TopicModel[];choice?:TopicNewSession;locked:boolean;loading:boolean;refreshing:boolean;unavailable:boolean;
  onRefresh():void;onChange(choice:TopicNewSession):void;
}){
  const [picker,setPicker]=useState<'model'|'effort'|'permission'|''>(''),[provider,setProvider]=useState(''),[query,setQuery]=useState('');
  const selected=models.find(model=>choice&&topicModelKey(model)===topicModelKey(choice));
  const providers=[...new Set(models.map(model=>model.provider))];
  const effort=selected?.thinkingOptions?.find(option=>option.id===choice?.thinkingOptionId)
    ||selected?.thinkingOptions?.find(option=>option.id===selected.defaultThinkingOptionId)||selected?.thinkingOptions?.find(option=>option.isDefault);
  const permission=selected?.permissionModes?.find(mode=>mode.id===choice?.modeId);
  const visibleProviders=providers.filter(value=>topicProviderLabel(value).toLowerCase().includes(query.toLowerCase()));
  const visibleModels=models.filter(model=>model.provider===provider&&(!query||[model.model,model.label].some(value=>value.toLowerCase().includes(query.toLowerCase()))));
  const rows=picker==='model'?(provider?visibleModels.length:visibleProviders.length):picker==='effort'?selected?.thinkingOptions?.length||0:(selected?.permissionModes?.length||0)+1;
  const open=(value:typeof picker)=>{setPicker(value);setProvider('');setQuery('');};
  useEffect(()=>{if(locked)setPicker('');},[locked]);
  return <View style={{gap:8}}>
    <Choice id="topics-model" icon="Cpu" disabled={locked||loading} onPress={()=>open('model')}
      label={loading?'加载模型':selected?topicProviderLabel(selected.provider)+' · '+selected.label:'选择 Provider / 模型'}/>
    <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
      <View style={{flex:1,minWidth:150}}><Choice id="topics-effort" icon="Brain" disabled={locked||!selected?.thinkingOptions?.length}
        onPress={()=>open('effort')} label={'推理强度 · '+(choice?.thinkingOptionId&&!selected?.thinkingOptions?.some(option=>option.id===choice.thinkingOptionId)?'重新选择':effort?topicEffortLabel(effort):'宿主默认')}/></View>
      <View style={{flex:1,minWidth:150}}><Choice id="topics-permission" icon="Shield" disabled={locked||!selected?.permissionModes?.length}
        onPress={()=>open('permission')} label={'权限 · '+(choice?.modeId&&!permission?'重新选择':permission?.label||'宿主默认')}/></View>
    </View>
    {unavailable||selected?.permissionsUnavailable||!loading&&!models.length?<View style={{flexDirection:'row',alignItems:'center',gap:8}}>
      <Label muted>{selected?.permissionsUnavailable?'权限列表暂不可用':unavailable?'模型列表暂不可用':'此主机暂无可用模型'}</Label>
      <TopicIcon icon="RefreshCw" label="刷新模型" busy={refreshing} onPress={onRefresh}/>
    </View>:null}
    {picker?<Dialog id="topics-session-picker" title={picker==='model'?'选择模型':picker==='effort'?'推理强度':'权限'} onClose={()=>setPicker('')} width={500} height={Math.min(520,Math.max(200,rows*44+(picker==='model'?150:90)))}>
      {picker==='model'?<>
        <View style={{paddingHorizontal:16,paddingTop:12,gap:8}}>
          {provider?<View style={{flexDirection:'row',alignItems:'center',gap:8}}>
            <Button icon="ArrowLeft" label="返回 Provider" variant="ghost" onPress={()=>{setProvider('');setQuery('');}}/>
            <Label strong>{topicProviderLabel(provider)}</Label>
          </View>:<Label muted>Provider</Label>}
          <View style={{flexDirection:'row',gap:8}}><Search value={query} onChange={setQuery} placeholder={provider?'搜索模型':'搜索 Provider'}/>
            <TopicIcon icon="RefreshCw" label="刷新模型" busy={refreshing} onPress={onRefresh}/></View>
        </View>
        <ScrollView contentContainerStyle={{padding:12,gap:3}}>
          {!rows?<Label muted>没有匹配项</Label>:null}
          {loading?<ActivityIndicator/>:!provider?visibleProviders.map(value=>
            <Option key={value} id={'topics-provider-'+value} label={topicProviderLabel(value)} icon="Layers" selected={value===choice?.provider}
              count={models.filter(model=>model.provider===value).length} nested onPress={()=>{setProvider(value);setQuery('');}}/>)
            :visibleModels.map(model=>
              <Option key={topicModelKey(model)} label={model.label} icon="Cpu" selected={Boolean(choice&&topicModelKey(model)===topicModelKey(choice))}
                onPress={()=>{onChange(topicModelChoice(model,choice));setPicker('');}}/>)}
        </ScrollView>
      </>:<ScrollView contentContainerStyle={{padding:12,gap:3}}>
        {picker==='effort'?selected?.thinkingOptions?.map(option=><Option key={option.id} id={'topics-effort-'+option.id} label={topicEffortLabel(option)} icon="Brain"
          selected={option.id===effort?.id} onPress={()=>{if(choice)onChange({...choice,thinkingOptionId:option.id});setPicker('');}}/>)
          :<><Option label="宿主默认" icon="Shield" selected={!choice?.modeId} onPress={()=>{if(choice)onChange({...choice,modeId:undefined});setPicker('');}}/>
            {selected?.permissionModes?.map(mode=><Option key={mode.id} id={'topics-permission-'+mode.id} label={mode.label} icon="Shield"
              selected={mode.id===choice?.modeId} onPress={()=>{if(choice)onChange({...choice,modeId:mode.id});setPicker('');}}/>)}</>}
      </ScrollView>}
    </Dialog>:null}
  </View>;
}
