import {memo,useState} from 'react';
import {Platform,Pressable,Text,View} from 'react-native';
import type {PluginWorkspacePanelProps} from '@getpaseo/plugin/client';
import {editorCodeFontFamily} from '../code-font';
import {IconButton} from './icon-button';

/** Readable scan rows; full messages belong in details, not unbounded list wrapping. */
export const ComparisonCommitRow=memo(function ComparisonCommitRow({commit,selected,onSelect,onDetails,theme}:{
 commit:{sha:string;subject:string};selected:boolean;onSelect():void;onDetails():void;theme:PluginWorkspacePanelProps['theme'];
}){
 const [hovered,setHovered]=useState(false),touch=Platform.OS!=='web';
 return <View testID={`comparison-commit-${commit.sha}`} style={{flexDirection:'row',alignItems:'center',borderBottomWidth:1,borderBottomColor:theme.colors.border,borderLeftWidth:2,borderLeftColor:selected?'#55bcf5':'transparent',backgroundColor:selected?theme.colors.surface2:hovered?theme.colors.surface1:'transparent'}}>
   <Pressable accessibilityRole="button" accessibilityLabel={`${commit.subject}，${commit.sha}`} accessibilityState={{selected}} {...(Platform.OS==='web'?{'aria-pressed':selected}:{})} onPress={onSelect} onLongPress={onDetails} onHoverIn={()=>setHovered(true)} onHoverOut={()=>setHovered(false)} style={{flex:1,minWidth:0,minHeight:touch?56:48,paddingVertical:7,paddingHorizontal:8,justifyContent:'center',gap:4}}>
     <Text testID="comparison-commit-subject" numberOfLines={1} ellipsizeMode="tail" style={{color:theme.colors.foreground,fontSize:13,fontWeight:'500',lineHeight:18}}>{commit.subject || '无提交说明'}</Text>
     <Text testID="comparison-commit-sha" style={{color:theme.colors.foregroundMuted,fontFamily:editorCodeFontFamily,fontSize:11,lineHeight:14}}>{commit.sha.slice(0,8)}</Text>
   </Pressable>
   <IconButton label={`提交详情 ${commit.sha.slice(0,8)}`} icon="Info" color={theme.colors.foregroundMuted} onPress={onDetails}/>
 </View>;
});
