import type { ReactNode } from 'react';
import { useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { TextInput, ScrollView } from '../native-components';
import {GeometricIcon} from '../geometric-icon';
export type SettingsTheme = PluginSurfaceProps['theme'];
export type SettingsCategory = 'home'|'models'|'extensions'|'history'|'display'|'project'|'session'|'review'|'recovery'|'runtime'|'storage'|'files'|'topics'|'production'|'organizer'|'diagnostics';
export const settingsCategories: Array<{id:SettingsCategory;label:string;description:string;icon:string}> = [
  {id:'models',label:'模型连接',description:'地址、认证、模型与生成测试',icon:'Bot'},
  {id:'organizer',label:'自动整理',description:'开关、范围、命名与更新规则',icon:'Sparkles'},
  {id:'extensions',label:'扩展管理',description:'启用、连接与扩展配置',icon:'Puzzle'},
  {id:'storage',label:'项目存储与缓存',description:'工作区目录、记录位置与空间',icon:'Database'},
  {id:'review',label:'审核配置',description:'模式、模型、角色、指令与复用',icon:'ShieldCheck'},
  {id:'session',label:'会话与执行',description:'会话关系、权限预设与执行模型',icon:'Terminal'},
  {id:'project',label:'项目与仓库',description:'仓库选择与聚合范围',icon:'Folder'},
  {id:'production',label:'生产与上线',description:'生产分支与覆盖判断',icon:'GitBranch'},
  {id:'runtime',label:'环境与工具链',description:'运行路径、mise 与工具版本',icon:'Package'},
  {id:'recovery',label:'自动恢复',description:'继续消息、重试与单会话覆盖',icon:'RefreshCw'},
  {id:'topics',label:'话题与资料',description:'服务连接、关注群与投递偏好',icon:'MessageSquare'},
  {id:'files',label:'文件与改动规则',description:'测试文件识别与默认筛选',icon:'FileConfig'},
  {id:'history',label:'历史预览与标题维护',description:'批量预览、应用、排除与恢复',icon:'Clock'},
  {id:'diagnostics',label:'状态与诊断',description:'运行记录、实际输入与失败原因',icon:'Activity'},
];
export const settingAccent = '#a7d9b8';
export function SettingsSurface({children,theme,testID}:{children:ReactNode;theme:SettingsTheme;testID?:string}) {return <View testID={testID} style={{minWidth:0,borderWidth:1,borderColor:theme.colors.border,borderRadius:10,backgroundColor:theme.colors.surface1,padding:15,gap:14}}>{children}</View>;}
export function SettingCard({title,children,theme,collapsed=false}:{title:string;children:ReactNode;theme:SettingsTheme;collapsed?:boolean}) {
  const [open,setOpen]=useState(!collapsed),[visited,setVisited]=useState(!collapsed);
  return <View style={{minWidth:0,borderWidth:1,borderColor:theme.colors.border,borderRadius:9,backgroundColor:theme.colors.surface1,overflow:'hidden'}}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{expanded:open}} onPress={()=>{setVisited(true);setOpen(v=>!v);}} style={{padding:14,flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:8}}><Text style={{color:theme.colors.foreground,fontSize:13,fontWeight:'600',flex:1}}>{title}</Text><GeometricIcon name={open?'ChevronDown':'ChevronRight'} color={theme.colors.foregroundMuted} size={13}/></Pressable>
    {visited?<View style={open?{padding:14,paddingTop:0,gap:12,minWidth:0}:{display:'none'}}>{children}</View>:null}
  </View>;
}
export function SettingButton({children,onPress,theme,disabled=false,primary=false,testID,quiet=false,compact=false,icon}:{children:ReactNode;onPress():void;theme:SettingsTheme;disabled?:boolean;primary?:boolean;testID?:string;quiet?:boolean;compact?:boolean;icon?:string}) {
  return <Pressable testID={testID} accessibilityRole="button" disabled={disabled} onPress={onPress} style={{minWidth:0,minHeight:compact?30:40,paddingHorizontal:compact?9:13,paddingVertical:compact?6:10,borderWidth:quiet?0:1,borderColor:primary?settingAccent:theme.colors.border,borderRadius:7,backgroundColor:primary?settingAccent:quiet?'transparent':theme.colors.surface2,opacity:disabled?.45:1,flexDirection:'row',gap:7,alignItems:'center',justifyContent:quiet?'flex-start':'center'}}>{icon?<GeometricIcon name={icon} color={primary?'#18291d':theme.colors.foregroundMuted} size={14}/>:null}<Text style={{flexShrink:1,color:primary?'#18291d':quiet?theme.colors.foregroundMuted:theme.colors.foreground,fontSize:12,fontWeight:primary?'600':'400',lineHeight:17}}>{children}</Text></Pressable>;
}
export function SettingText({children,theme,error=false}:{children:ReactNode;theme:SettingsTheme;error?:boolean}) {return <Text selectable style={{flexShrink:1,color:error?theme.colors.statusWarning:theme.colors.foregroundMuted,fontSize:12,lineHeight:19}}>{children}</Text>;}
export function SettingHeading({children,theme,small=false}:{children:ReactNode;theme:SettingsTheme;small?:boolean}) {return <Text style={{color:theme.colors.foreground,fontSize:small?13:22,fontWeight:'600',lineHeight:small?20:29}}>{children}</Text>;}
export function SettingField({label,value,onChange,theme,multiline=false,secret=false,placeholder,testID}:{label:string;value:string;onChange(value:string):void;theme:SettingsTheme;multiline?:boolean;secret?:boolean;placeholder?:string;testID?:string}) {
  return <View style={{gap:7,minWidth:0}}><Text style={{color:theme.colors.foreground,fontSize:12}}>{label}</Text><TextInput testID={testID} accessibilityLabel={label} value={value} onChangeText={onChange} multiline={multiline} secureTextEntry={secret} placeholder={placeholder} autoCapitalize="none" autoCorrect={false} placeholderTextColor={theme.colors.foregroundMuted} style={{color:theme.colors.foreground,borderWidth:1,borderColor:theme.colors.border,borderRadius:7,padding:10,minHeight:multiline?90:40,fontSize:12,lineHeight:19,textAlignVertical:'top'}}/></View>;
}
export function SettingSwitch({label,value,onChange,theme,hint,disabled=false}:{label:string;value:boolean;onChange(value:boolean):void;theme:SettingsTheme;hint?:string;disabled?:boolean}) {
  return <Pressable accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{checked:value,disabled}} {...(Platform.OS==='web'?{'aria-checked':value}:{})} disabled={disabled} onPress={()=>onChange(!value)} style={{minHeight:40,flexDirection:'row',alignItems:'center',gap:10,opacity:disabled?.5:1}}><View style={{flex:1,gap:4,minWidth:0}}><Text style={{color:theme.colors.foreground,fontSize:13,fontWeight:'500'}}>{label}</Text>{hint?<Text style={{color:theme.colors.foregroundMuted,fontSize:11,lineHeight:17}}>{hint}</Text>:null}</View><View style={{width:38,height:22,borderRadius:12,backgroundColor:value?'#669878':theme.colors.surface2,borderWidth:1,borderColor:theme.colors.border,alignItems:value?'flex-end':'flex-start',justifyContent:'center',padding:2}}><View style={{width:16,height:16,borderRadius:8,backgroundColor:value?'#f1f9f1':theme.colors.foregroundMuted}}/></View></Pressable>;
}
export function SettingSelect({label,value,options,onChange,theme}:{label:string;value:string;options:Array<{value:string;label:string}>;onChange(value:string):void;theme:SettingsTheme}) {
  const [open,setOpen]=useState(false);
  return <View style={{gap:7,minWidth:0}}>{label?<Text style={{color:theme.colors.foreground,fontSize:12}}>{label}</Text>:null}<Pressable accessibilityRole="button" accessibilityLabel={label||'选择'} accessibilityState={{expanded:open}} onPress={()=>setOpen(v=>!v)} style={{minHeight:40,padding:10,borderWidth:1,borderColor:theme.colors.border,borderRadius:7,flexDirection:'row',alignItems:'center',gap:8}}><Text numberOfLines={1} style={{color:theme.colors.foreground,fontSize:12,flex:1}}>{options.find(o=>o.value===value)?.label||value||'请选择'}</Text><GeometricIcon name={open?'ChevronUp':'ChevronDown'} size={12} color={theme.colors.foregroundMuted}/></Pressable>{open?<ScrollView style={{maxHeight:320,borderWidth:1,borderColor:theme.colors.border,borderRadius:7}}>{options.map(option=><Pressable key={option.value} accessibilityRole="button" accessibilityState={{selected:option.value===value}} onPress={()=>{onChange(option.value);setOpen(false);}} style={{padding:11,minHeight:40,backgroundColor:option.value===value?'#66987822':theme.colors.surface1}}><Text style={{color:theme.colors.foreground,fontSize:12}}>{option.value===value?'✓ ':''}{option.label}</Text></Pressable>)}</ScrollView>:null}</View>;
}
export function SettingPill({children,theme,tone='muted'}:{children:ReactNode;theme:SettingsTheme;tone?:'green'|'amber'|'blue'|'muted'}) {
  const color=tone==='green'?'#73ad83':tone==='amber'?'#c09a54':tone==='blue'?'#6aa2c8':theme.colors.foregroundMuted;
  return <View style={{alignSelf:'flex-start',backgroundColor:tone==='muted'?theme.colors.surface2:color+'20',paddingHorizontal:7,paddingVertical:4,borderRadius:5,maxWidth:'100%'}}><Text style={{color,fontSize:10,lineHeight:14}}>{children}</Text></View>;
}
export function SettingLink({title,description,icon,onPress,theme}:{title:string;description?:string;icon:string;onPress():void;theme:SettingsTheme}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress} style={{minHeight:64,paddingVertical:13,flexDirection:'row',gap:12,alignItems:'center',minWidth:0}}><View style={{width:32,height:32,alignItems:'center',justifyContent:'center',borderWidth:1,borderColor:theme.colors.border,borderRadius:8,backgroundColor:theme.colors.surface2}}><GeometricIcon name={icon} size={17} color={theme.colors.foregroundMuted}/></View><View style={{flex:1,gap:4,minWidth:0}}><Text style={{color:theme.colors.foreground,fontSize:13,fontWeight:'500'}}>{title}</Text>{description?<Text style={{color:theme.colors.foregroundMuted,fontSize:11,lineHeight:16}}>{description}</Text>:null}</View><GeometricIcon name="ChevronRight" size={13} color={theme.colors.foregroundMuted}/></Pressable>;
}
export function SettingSegments({options,value,onChange,theme}:{options:Array<{value:string;label:string}>;value:string;onChange(value:string):void;theme:SettingsTheme}) {return <View style={{flexDirection:'row',gap:4,padding:4,borderWidth:1,borderColor:theme.colors.border,borderRadius:8}}>{options.map(o=><Pressable key={o.value} accessibilityRole="button" accessibilityLabel={o.label} accessibilityState={{selected:value===o.value}} onPress={()=>onChange(o.value)} style={{flex:1,minWidth:0,paddingVertical:9,paddingHorizontal:5,borderRadius:5,backgroundColor:value===o.value?theme.colors.surface2:'transparent',alignItems:'center'}}><Text style={{fontSize:12,fontWeight:value===o.value?'600':'400',color:value===o.value?theme.colors.foreground:theme.colors.foregroundMuted}}>{o.label}</Text></Pressable>)}</View>;}
export function OrganizerSteps({phase,theme}:{phase:number;theme:SettingsTheme}) {return <View style={{flexDirection:'row',alignItems:'center',gap:4,paddingVertical:8}}>{['选择材料','模型生成','核对预览','应用标题'].map((label,index)=><View key={label} style={{flex:1,gap:7,alignItems:'center',minWidth:0}}><View style={{width:22,height:22,borderRadius:11,borderWidth:1,borderColor:index<=phase?'#669878':theme.colors.border,backgroundColor:index===phase?settingAccent:index<phase?'#66987822':'transparent',alignItems:'center',justifyContent:'center'}}>{index<phase?<GeometricIcon name="Check" color="#669878" size={12}/>:<Text style={{color:index===phase?'#18291d':theme.colors.foregroundMuted,fontSize:10}}>{index+1}</Text>}</View><Text style={{fontSize:10,color:index===phase?theme.colors.foreground:theme.colors.foregroundMuted}}>{label}</Text></View>)}</View>;}
