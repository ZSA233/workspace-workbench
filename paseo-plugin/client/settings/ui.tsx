import type { ReactNode } from 'react';
import { useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { TextInput, ScrollView } from '../native-components';
export type SettingsTheme = PluginSurfaceProps['theme'];
export type SettingsCategory = 'display'|'project'|'session'|'review'|'recovery'|'runtime'|'storage'|'files'|'topics'|'production'|'organizer'|'diagnostics';
export const settingsCategories: Array<{id:SettingsCategory;label:string}> = [
  {id:'display',label:'常用与显示'},{id:'project',label:'项目与仓库'},{id:'session',label:'会话与执行'},{id:'review',label:'代码评审'},
  {id:'recovery',label:'自动恢复'},{id:'runtime',label:'环境与工具链'},{id:'storage',label:'缓存与存储'},{id:'files',label:'文件与改动'},
  {id:'topics',label:'话题与资料'},{id:'production',label:'生产与上线'},{id:'organizer',label:'标题与自动整理'},{id:'diagnostics',label:'状态与诊断'},
];
export function SettingCard({title,children,theme,collapsed=false}:{title:string;children:ReactNode;theme:SettingsTheme;collapsed?:boolean}) {
  const [open,setOpen]=useState(!collapsed);
  const [visited,setVisited]=useState(!collapsed);
  return <View style={{borderWidth:1,borderColor:theme.colors.border,borderRadius:7,backgroundColor:theme.colors.surface1,overflow:'hidden'}}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{expanded:open}} onPress={()=>{setVisited(true);setOpen(v=>!v);}} style={{padding:12,flexDirection:'row',justifyContent:'space-between',gap:8}}><Text style={{color:theme.colors.foreground,fontSize:13,fontWeight:'600',flex:1}}>{title}</Text><Text style={{color:theme.colors.foregroundMuted}}>{open?'⌃':'⌄'}</Text></Pressable>
    {visited?<View style={open?{padding:12,paddingTop:0,gap:10}:{display:'none'}}>{children}</View>:null}
  </View>;
}
export function SettingButton({children,onPress,theme,disabled=false,primary=false,testID}:{children:ReactNode;onPress():void;theme:SettingsTheme;disabled?:boolean;primary?:boolean;testID?:string}) {
  return <Pressable testID={testID} accessibilityRole="button" disabled={disabled} onPress={onPress} style={{minHeight:36,paddingHorizontal:10,paddingVertical:8,borderWidth:1,borderColor:primary?'#55b4f5':theme.colors.border,borderRadius:5,backgroundColor:primary?'#2379af':theme.colors.surface2,opacity:disabled?.45:1,alignItems:'center',justifyContent:'center'}}><Text style={{color:primary?'#ffffff':theme.colors.foreground,fontSize:12}}>{children}</Text></Pressable>;
}
export function SettingText({children,theme,error=false}:{children:ReactNode;theme:SettingsTheme;error?:boolean}) {return <Text selectable style={{color:error?theme.colors.statusWarning:theme.colors.foregroundMuted,fontSize:12,lineHeight:18}}>{children}</Text>;}
export function SettingField({label,value,onChange,theme,multiline=false,secret=false,placeholder,testID}:{label:string;value:string;onChange(value:string):void;theme:SettingsTheme;multiline?:boolean;secret?:boolean;placeholder?:string;testID?:string}) {
  return <View style={{gap:5}}><Text style={{color:theme.colors.foreground,fontSize:12}}>{label}</Text><TextInput testID={testID} accessibilityLabel={label} value={value} onChangeText={onChange} multiline={multiline} secureTextEntry={secret} placeholder={placeholder} autoCapitalize="none" autoCorrect={false} placeholderTextColor={theme.colors.foregroundMuted} style={{color:theme.colors.foreground,borderWidth:1,borderColor:theme.colors.border,borderRadius:5,padding:8,minHeight:multiline?80:36,fontSize:12,textAlignVertical:'top'}}/></View>;
}
export function SettingSwitch({label,value,onChange,theme,hint}:{label:string;value:boolean;onChange(value:boolean):void;theme:SettingsTheme;hint?:string}) {
  return <Pressable accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{checked:value}} {...(Platform.OS==='web'?{'aria-checked':value}:{})} onPress={()=>onChange(!value)} style={{minHeight:40,flexDirection:'row',alignItems:'center',gap:10}}><View style={{flex:1,gap:3}}><Text style={{color:theme.colors.foreground,fontSize:12}}>{label}</Text>{hint?<SettingText theme={theme}>{hint}</SettingText>:null}</View><View style={{width:34,height:20,borderRadius:12,backgroundColor:value?'#249be7':theme.colors.surface2,borderWidth:1,borderColor:theme.colors.border,alignItems:value?'flex-end':'flex-start',justifyContent:'center',padding:2}}><View style={{width:14,height:14,borderRadius:8,backgroundColor:value?'#fff':theme.colors.foregroundMuted}}/></View></Pressable>;
}
export function SettingSelect({label,value,options,onChange,theme}:{label:string;value:string;options:Array<{value:string;label:string}>;onChange(value:string):void;theme:SettingsTheme}) {
  const [open,setOpen]=useState(false);
  return <View style={{gap:5}}>{label?<Text style={{color:theme.colors.foreground,fontSize:12}}>{label}</Text>:null}<Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{expanded:open}} onPress={()=>setOpen(v=>!v)} style={{minHeight:36,padding:9,borderWidth:1,borderColor:theme.colors.border,borderRadius:5,flexDirection:'row',gap:8}}><Text numberOfLines={1} style={{color:theme.colors.foreground,fontSize:12,flex:1}}>{options.find(o=>o.value===value)?.label||value||'请选择'}</Text><Text style={{color:theme.colors.foregroundMuted}}>{open?'⌃':'⌄'}</Text></Pressable>{open?<ScrollView style={{maxHeight:360,borderWidth:1,borderColor:theme.colors.border,borderRadius:5}}>{options.map(option=><Pressable key={option.value} accessibilityRole="button" accessibilityState={{selected:option.value===value}} onPress={()=>{onChange(option.value);setOpen(false);}} style={{padding:10,minHeight:36,backgroundColor:option.value===value?'#25638a33':theme.colors.surface1}}><Text style={{color:option.value===value?'#65b8f5':theme.colors.foreground,fontSize:12}}>{option.value===value?'✓ ':''}{option.label}</Text></Pressable>)}</ScrollView>:null}</View>;
}
