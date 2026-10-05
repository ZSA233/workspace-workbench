import {keyboardOverlap} from '../comparison-display';
import {useEffect,useState,type ReactNode} from 'react';
import {Keyboard,Modal,Platform,Pressable,Text,View,useWindowDimensions} from 'react-native';
import {ScrollView} from '../native-components';
import {IconButton} from './icon-button';
import type {PluginWorkspacePanelProps} from '@getpaseo/plugin/client';
export type PopoverAnchor={x:number;y:number;width:number;height:number};
/** This surface is separate from destructive-action dialogs. */
export function ComparisonPopover({title,anchor,onClose,children,theme}:{title:string;anchor:PopoverAnchor;onClose():void;children:ReactNode;theme:PluginWorkspacePanelProps['theme']}){
 const window=useWindowDimensions(),native=Platform.OS!=='web';
 const [keyboardTop,setKeyboardTop]=useState<number|null>(null);
 const keyboard=keyboardOverlap(window.height,keyboardTop);
 useEffect(()=>{
   if(!native||!Keyboard?.addListener)return;
   const show=Keyboard.addListener('keyboardDidShow',e=>setKeyboardTop(e.endCoordinates.screenY));
   const hide=Keyboard.addListener('keyboardDidHide',()=>setKeyboardTop(null));
   return()=>{show.remove();hide.remove();};
 },[native]);
 const modalAvailable=typeof Modal==='function'||!!Modal&&typeof Modal==='object';
 const width=Math.min(380,modalAvailable?window.width-16:Math.max(160,anchor.width));
 const body=(
   <View style={{flex:1,justifyContent:'flex-end',paddingBottom:keyboard}}>
     <Pressable accessibilityRole="button" accessibilityLabel="关闭比较设置" onPress={onClose} style={{position:'absolute',top:0,bottom:0,left:0,right:0,backgroundColor:native?'#0005':'transparent'}}/>
     <View testID="comparison-popover" accessibilityViewIsModal style={[{backgroundColor:theme.colors.surface1,borderColor:theme.colors.border,borderWidth:1,padding:12,maxHeight:Math.max(140,window.height-keyboard-32),borderRadius:8},native?{borderBottomLeftRadius:0,borderBottomRightRadius:0}:{position:'absolute',width,left:modalAvailable?Math.max(8,Math.min(anchor.x+anchor.width-width,window.width-width-8)):0,top:modalAvailable?Math.max(8,Math.min(anchor.y+anchor.height+4,window.height-400)):anchor.height,maxHeight:Math.max(140,window.height-Math.max(8,Math.min(anchor.y+anchor.height+4,window.height-400))-8)}]}>
       <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between'}}><Text accessibilityRole="header" style={{color:theme.colors.foreground,fontSize:14,fontWeight:'600'}}>{title}</Text><IconButton label="关闭比较设置" icon="X" color={theme.colors.foregroundMuted} onPress={onClose}/></View>
       <ScrollView keyboardShouldPersistTaps="handled" style={{flexShrink:1}} contentContainerStyle={{gap:4,paddingBottom:native?16:0}}>{children}</ScrollView>
     </View>
   </View>
 );
 return modalAvailable?<Modal transparent visible onRequestClose={onClose} animationType={native?'slide':'none'}>{body}</Modal>:<View style={{position:'absolute',top:0,left:0,right:0,bottom:0,zIndex:100,elevation:20}}>{body}</View>;
}
