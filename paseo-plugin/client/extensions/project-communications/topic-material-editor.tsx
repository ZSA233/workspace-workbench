import {useMemo,useState} from 'react';
import {View} from 'react-native';
import {Icon,ScrollView,TextInput} from '../../native-components';
import type {TopicsClient} from '../../use-topics';
import {basketContentEntries,type TopicBasket} from '../../topic-selection';
import type {ArchiveMessage} from '../../../shared/extensions/project-communications/topics';
import {messageText} from '../../../shared/extensions/project-communications/topics';
import {prepareTopicContent,topicBuiltInTemplates,topicContentOptions,topicTemplateError,TOPIC_TEXT_LIMIT,
  type TopicContentAlias,type TopicMaterialSettings,type TopicTemplate} from '../../../shared/extensions/project-communications/topic-content';
import {Badge,Button,Dialog,Field,Label,Toggle,useColors} from './ui';
import {TopicAsset,TopicIcon} from './topic-ui';

export function useTopicMaterialDraft(basket:TopicBasket,settings:TopicMaterialSettings,note:string,aliases:TopicContentAlias[]){
  const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Shanghai';
  const options=useMemo(()=>({...topicContentOptions(settings,timeZone),aliases}),[settings,timeZone,aliases]);
  const draft=useMemo(()=>{
    try{return {...prepareTopicContent(basketContentEntries(basket),options,note,Object.values(basket).filter(item=>item.includeAnalysis).map(item=>item.topic.lastAnswer||item.topic.summary||'')),error:''};}
    catch(error){return {text:'',rows:[],people:[],conversation:false,unresolved:[],error:error instanceof Error?error.message:String(error)};}
  },[basket,options,note]);
  return {draft,options};
}

type Props={client:TopicsClient;basket:TopicBasket;settings:TopicMaterialSettings;note:string;locked:boolean;
  onSettings(settings:TopicMaterialSettings):void;onEdit(message:ArchiveMessage,text:string|undefined):void;
  draft:ReturnType<typeof useTopicMaterialDraft>['draft']};
const shortName=(name:string,length=18)=>Array.from(name).length>length?Array.from(name).slice(0,length).join('')+'…':name;

export function TopicMaterialActions({basket,settings,note,locked,onSettings,draft,client}:Props){
  const [dialog,setDialog]=useState<'menu'|'people'|'preview'|''>(''),[editor,setEditor]=useState<TopicTemplate>();
  const templates=[...topicBuiltInTemplates,...settings.presets],preset=templates.find(item=>item.id===settings.presetId)||templates[0];
  const save=(value:TopicTemplate)=>{
    const previous=settings.presets.some(item=>item.id===value.id),id=previous?value.id:'custom-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
    onSettings({...settings,presetId:id,presets:previous?settings.presets.map(item=>item.id===id?value:item):[...settings.presets,{...value,id}]});setEditor(undefined);
  };
  return <>
    <View style={{flexDirection:'row',alignItems:'center',gap:7}}>
      <Badge tone="info">{draft.conversation?'对话 · 按时间':'简洁'}</Badge>
      {settings.identity==='alias'?<Badge>化名</Badge>:null}
      {preset.id!=='forward'?<Badge>{shortName(preset.name,10)}</Badge>:null}
      {draft.unresolved.length?<Button variant="link" icon="CircleHelp" onPress={()=>setDialog('people')}>{draft.unresolved.length+' 待确认'}</Button>:null}
      <TopicIcon id="topics-material-menu" icon="Ellipsis" label="材料处理与预设" disabled={locked} onPress={()=>setDialog('menu')}/>
    </View>
    {dialog==='menu'?<Dialog title="材料处理" onClose={()=>setDialog('')} width={560} height={520}>
      <ScrollView contentContainerStyle={{padding:18,gap:16}}>
        <View style={{flexDirection:'row',flexWrap:'wrap',gap:7}}>
          {([['auto','自动','WandSparkles'],['conversation','对话','Users'],['text','文字','AlignLeft']] as const).map(([layout,label,icon])=>
            <Button key={layout} icon={icon} active={settings.layout===layout} onPress={()=>onSettings({...settings,layout})}>{label}</Button>)}
        </View>
        <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:8}}>
          <Toggle label="参与者化名" checked={settings.identity==='alias'} onChange={value=>onSettings({...settings,identity:value?'alias':'name'})}/>
          <Button variant="link" icon="Users" onPress={()=>setDialog('people')}>查看对应</Button>
        </View>
        <View style={{gap:7}}><Label muted>说明预设</Label>
          {templates.map(item=><View key={item.id} style={{flexDirection:'row',alignItems:'center',gap:6}}>
            <View style={{flex:1}}><Button id={'topic-preset-'+item.id} icon={item.id===settings.presetId?'Check':'FileText'} active={item.id===settings.presetId}
              label={item.name} onPress={()=>onSettings({...settings,presetId:item.id})}>{shortName(item.name)}</Button></View>
            <TopicIcon icon="PenLine" label={'编辑预设 '+item.name} onPress={()=>setEditor(item)}/>
            {settings.presets.some(preset=>preset.id===item.id)?<TopicIcon icon="Trash2" label={'删除预设 '+item.name} onPress={()=>onSettings({...settings,
              presetId:settings.presetId===item.id?'forward':settings.presetId,presets:settings.presets.filter(preset=>preset.id!==item.id)})}/>:null}
          </View>)}
          <Button id="topics-template-new" icon="Plus" disabled={settings.presets.length>=8} onPress={()=>setEditor({id:'',name:'我的预设',body:preset.body})}>新建预设</Button>
        </View>
        <Button id="topics-content-preview" icon="FileText" onPress={()=>setDialog('preview')}>预览发送内容</Button>
      </ScrollView>
    </Dialog>:null}
    {editor?<TemplateEditor value={editor} canSave={Boolean(settings.presets.some(item=>item.id===editor.id)||settings.presets.length<8)} onClose={()=>setEditor(undefined)} onSave={save}/>:null}
    {dialog==='people'?<Dialog title="参与者对应" onClose={()=>setDialog('menu')} width={500} height={450}>
      <ScrollView contentContainerStyle={{padding:18,gap:12}}>
        {draft.people.map(person=><View key={person.key} style={{flexDirection:'row',gap:10,alignItems:'center'}}><Label>{person.name}</Label><Icon name="ArrowRight" size={14}/><Badge tone="info">{person.label}</Badge></View>)}
        {draft.unresolved.length?<><Label muted>以下称呼待确认，可在原文中编辑</Label>{draft.unresolved.map(name=><Label key={name} warning>{'@'+name}</Label>)}</>:null}
      </ScrollView>
    </Dialog>:null}
    {dialog==='preview'?<Dialog id="topics-final-content" title="发送预览" onClose={()=>setDialog('menu')} width={800} height={720}>
      <ScrollView contentContainerStyle={{padding:18,gap:14}}>
        <Label>{draft.text}</Label>
        {draft.rows.flatMap(row=>row.message.assets.filter(asset=>row.assetIds?.includes(asset.id)).map(asset=><TopicAsset key={row.key+asset.id}
          {...{client,asset,message:row.message}} topicId={row.topicId} contextOf={basket[row.topicId]?.contexts[row.message.id]} checked disabled onToggle={()=>undefined}/>))}
      </ScrollView>
    </Dialog>:null}
  </>;
}

function TemplateEditor({value,canSave,onSave,onClose}:{value:TopicTemplate;canSave:boolean;onSave(value:TopicTemplate):void;onClose():void}){
  const c=useColors(),[name,setName]=useState(value.name),[body,setBody]=useState(value.body),error=topicTemplateError(body);
  return <Dialog id="topics-template-editor" title="编辑说明预设" onClose={onClose} width={640} height={560}
    footer={<><Button onPress={onClose}>取消</Button><Button id="topics-template-save" variant="primary" disabled={!canSave||!name.trim()||name.length>40||Boolean(error)}
      onPress={()=>onSave({...value,name:name.trim(),body})}>保存预设</Button></>}>
    <ScrollView contentContainerStyle={{padding:18,gap:12}}>
      <Field id="topics-template-name" label="名称" value={name} onChange={setName}/>
      <View style={{flexDirection:'row',gap:7}}><Button onPress={()=>setBody(current=>current+'{{note}}')}>插入本次说明</Button><Button onPress={()=>setBody(current=>current+'{{materials}}')}>插入所选材料</Button></View>
      <TextInput testID="topics-template-body" accessibilityLabel="模板内容" value={body} onChangeText={setBody} multiline maxLength={12000}
        autoCapitalize="none" autoCorrect={false} style={{minHeight:220,maxHeight:340,padding:12,borderWidth:1,borderColor:c.border,borderRadius:6,color:c.foreground,fontSize:13,lineHeight:22,textAlignVertical:'top'}}/>
      {error?<Label warning>{error}</Label>:null}
    </ScrollView>
  </Dialog>;
}

export function TopicMaterialRows({client,basket,settings,locked,onEdit,draft}:Props){
  const c=useColors(),[editing,setEditing]=useState('');
  return <View style={{gap:14}}>
    {draft.rows.map(row=><View key={row.key} testID={'topic-content-row-'+row.message.id} style={{gap:7,paddingLeft:12,borderLeftWidth:2,borderLeftColor:c.accent}}>
      <View style={{flexDirection:'row',alignItems:'center',gap:7}}>
        <View style={{flex:1}}><Label muted>{draft.conversation?row.speaker+' · '+row.time:'原文'}</Label></View>
        {row.edited?<Badge tone="info">已编辑</Badge>:null}
        <TopicIcon id={'topics-edit-'+row.message.id} icon={editing===row.key?'Check':'PenLine'} label={editing===row.key?'完成编辑':row.includeText===false?'补充文字':'编辑这段文字'} disabled={locked}
          onPress={()=>{if(row.includeText===false)onEdit(row.message,'');setEditing(current=>current===row.key?'':row.key);}}/>
        {row.edited?<TopicIcon id={'topics-reset-'+row.message.id} icon="RotateCcw" label="还原原文" disabled={locked} onPress={()=>onEdit(row.message,undefined)}/>:null}
      </View>
      {row.replyTo&&draft.conversation?<Label muted>{'回复 '+row.replyTo}</Label>:null}
      {editing===row.key?<>
        <TextInput testID={'topics-edit-text-'+row.message.id} accessibilityLabel="本次发送的文字" value={row.editedText===undefined?messageText(row.message):row.editedText}
          onChangeText={text=>onEdit(row.message,text)} editable={!locked} multiline maxLength={TOPIC_TEXT_LIMIT} autoCapitalize="none" autoCorrect={false}
          style={{minHeight:90,maxHeight:240,padding:10,borderWidth:1,borderColor:c.border,borderRadius:6,color:c.foreground,fontSize:13,lineHeight:22,textAlignVertical:'top'}}/>
        {settings.identity==='alias'&&row.text!==(row.editedText===undefined?messageText(row.message):row.editedText)?<><Label muted>化名预览</Label><Label>{row.text}</Label></>:null}
      </>:row.text?<Label>{row.text}</Label>:null}
      <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
        {row.message.assets.filter(asset=>row.assetIds?.includes(asset.id)).map(asset=><TopicAsset key={asset.id} {...{client,asset,message:row.message}}
          topicId={row.topicId} contextOf={basket[row.topicId]?.contexts[row.message.id]} checked disabled onToggle={()=>undefined}/>)}
      </View>
    </View>)}
    {Object.values(basket).filter(item=>item.includeAnalysis).map(item=><View key={item.topic.id} style={{gap:6}}><Label muted>所选分析</Label><Label>{item.topic.lastAnswer||item.topic.summary}</Label></View>)}
    {draft.error?<Label warning>材料内容暂不可用，请检查预设</Label>:null}
  </View>;
}
