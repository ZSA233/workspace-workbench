import {createElement,useEffect,useRef,type ReactNode} from 'react';
import {Platform,Pressable,Text,View,type StyleProp,type ViewStyle,type ViewProps} from 'react-native';
import type {PluginWorkspacePanelProps} from '@getpaseo/plugin/client';
import {useWorkbenchLocale} from '../i18n';
import type {TabCloseMode} from '../tab-close';
import {ComparisonPopover,type PopoverAnchor} from './comparison-popover';

type Gesture={id:number;x:number;y:number};
export type TabMenuTarget={key:string;anchor:PopoverAnchor;gesture?:Gesture};

/** DOM mouse events must live on an actual DOM node, not a filtered native View prop. */
export function EditorTab({tabKey,onClose,onMenu,style,onLayout,children}:{tabKey:string;onClose():void;onMenu(target:TabMenuTarget):void;style?:StyleProp<ViewStyle>;onLayout?:ViewProps['onLayout'];children(openMenu:()=>void):ReactNode}){
 const ref=useRef<any>(null),gesture=useRef<Gesture|undefined>(undefined);
 const open=()=>{
  const current=gesture.current;
  if(ref.current?.measureInWindow)ref.current.measureInWindow((x:number,y:number,width:number,height:number)=>onMenu({key:tabKey,anchor:{x,y,width,height},gesture:current}));
  else onMenu({key:tabKey,anchor:{x:8,y:8,width:0,height:0},gesture:current});
 };
 const content=children(open);
 return <View ref={ref} onLayout={onLayout} style={style}>{Platform.OS==='web'?createElement('div',{
  'data-editor-tab':tabKey,
  style:{display:'flex',alignItems:'center',alignSelf:'stretch'},
  onPointerDownCapture:(event:any)=>{gesture.current=event.pointerType==='touch'||event.pointerType==='pen'?{id:event.pointerId,x:event.clientX,y:event.clientY}:undefined;},
  onMouseDownCapture:(event:any)=>{if(event.button===1){event.preventDefault();event.stopPropagation();}},
  onAuxClickCapture:(event:any)=>{if(event.button===1){event.preventDefault();event.stopPropagation();onClose();}},
  onContextMenu:(event:any)=>{event.preventDefault();event.stopPropagation();onMenu({key:tabKey,anchor:{x:event.clientX,y:event.clientY,width:0,height:0},gesture:gesture.current});},
 } as any,content):content}</View>;
}

export function TabContextMenu({target,keys,label,description,onClose,onAction,theme}:{target:TabMenuTarget;keys:string[];label:string;description:string;onClose():void;onAction(mode:TabCloseMode):void;theme:PluginWorkspacePanelProps['theme']}){
 const zh=useWorkbenchLocale()==='zh-CN',c=theme.colors,index=keys.indexOf(target.key);
 useEffect(()=>{
  const document=(globalThis as any).document,gesture=target.gesture;
  if(Platform.OS!=='web'||!document||!gesture)return;
  // Consume only the release click from the long press that opened the portal.
  // A later tap on a menu item keeps its own pointer and remains actionable.
  let until=Infinity,consumed=false;
  const release=()=>{until=Date.now()+500;};
  const click=(event:any)=>{
   if(consumed||Date.now()>until)return;
   const origin=typeof event.pointerId==='number'&&event.pointerId>=0?event.pointerId===gesture.id:Math.abs(event.clientX-gesture.x)<12&&Math.abs(event.clientY-gesture.y)<12;
   if(origin){consumed=true;event.preventDefault();event.stopImmediatePropagation();}
  };
  document.addEventListener('pointerup',release,true);document.addEventListener('pointercancel',release,true);document.addEventListener('click',click,true);
  return()=>{document.removeEventListener('pointerup',release,true);document.removeEventListener('pointercancel',release,true);document.removeEventListener('click',click,true);};
 },[target]);
 if(index<0)return null;
 const options:[TabCloseMode,string,boolean][]=[
  ['current',zh?'关闭':'Close',false],
  ['others',zh?'关闭其他':'Close others',keys.length<2],
  ['left',zh?'关闭左侧所有':'Close tabs to the left',index===0],
  ['right',zh?'关闭右侧所有':'Close tabs to the right',index===keys.length-1],
  ['all',zh?'关闭全部':'Close all',false],
 ];
 return <ComparisonPopover title={zh?'页签操作':'Tab actions'} closeLabel={zh?'关闭页签菜单':'Dismiss tab menu'} testID="editor-tab-menu" anchor={target.anchor} onClose={onClose} theme={theme}>
  <Text numberOfLines={1} style={{color:c.foreground,fontSize:12,fontWeight:'600'}}>{label}</Text>
  <Text numberOfLines={2} style={{color:c.foregroundMuted,fontSize:11,marginBottom:4}}>{description}</Text>
  {options.map(([mode,title,disabled])=><Pressable key={mode} accessibilityRole="button" accessibilityState={{disabled}} disabled={disabled} onPress={()=>{onClose();onAction(mode);}} style={{paddingVertical:10,paddingHorizontal:4,opacity:disabled?0.4:1}}><Text style={{color:c.foreground,fontSize:12}}>{title}</Text></Pressable>)}
 </ComparisonPopover>;
}
