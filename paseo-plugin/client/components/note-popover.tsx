import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Platform,View} from 'react-native';
import type {PluginWorkspacePanelProps} from '@getpaseo/plugin/client';
import {ScrollView} from '../native-components';
import {ComparisonPopover} from './comparison-popover';
import {notePopoverPlacement,type NoteRect} from '../note-popover-model';
/** Desktop is non-modal so the code remains scrollable and markers remain clickable. */
export function NotePopover({anchor,bounds,brief,onClose,theme,children}:{anchor:NoteRect;bounds:NoteRect;brief:boolean;onClose(restoreFocus?:boolean):void;theme:PluginWorkspacePanelProps['theme'];children:ReactNode}){
 const ref=useRef<any>(null),close=useRef(onClose);close.current=onClose;
 const [viewport,setViewport]=useState<{top:number;bottom:number}|null>(null);
 const [height,setHeight]=useState(brief?176:420);
 const native=Platform.OS!=='web',sheet=native||bounds.width<480;
 const top=viewport?Math.max(bounds.y,viewport.top):bounds.y;
 const area=viewport?{...bounds,y:top,height:Math.max(0,Math.min(bounds.y+bounds.height,viewport.bottom)-top)}:bounds;
 const maximum=Math.max(80,(area.height||600)*(brief ? 0.45 : 0.85));
 const placement=notePopoverPlacement(area,anchor,Math.min(height,maximum),sheet);
 const position={...placement,top:placement.top+area.y-bounds.y};
 useEffect(()=>{if(native)return;const visual=(globalThis as any).window?.visualViewport;if(!visual)return;const update=()=>setViewport({top:visual.offsetTop,bottom:visual.offsetTop+visual.height});update();visual.addEventListener("resize",update);visual.addEventListener("scroll",update);return()=>{visual.removeEventListener("resize",update);visual.removeEventListener("scroll",update);};},[native]);
 useEffect(()=>{
  if(native)return;
  const document=(globalThis as any).document;if(!document)return;
  const pointer=(e:any)=>{if(ref.current?.contains?.(e.target)||e.target?.closest?.('[data-testid^="note-marker-"],[data-testid="note-toolbar"]'))return;close.current();};
  const key=(e:any)=>{if(e.key==='Escape'){e.preventDefault();close.current(true);}};
  document.addEventListener('pointerdown',pointer,true);document.addEventListener('keydown',key,true);
  return()=>{document.removeEventListener('pointerdown',pointer,true);document.removeEventListener('keydown',key,true);};
 },[native]);
 if(native)return <ComparisonPopover title="" hideHeader noteBrief={brief} anchor={anchor} theme={theme} onClose={onClose} testID="change-notes-popover">{children}</ComparisonPopover>;
 return <View ref={ref} testID="change-notes-popover" role="dialog" style={{position:'absolute',...position,maxHeight:Math.min(position.maxHeight,maximum),borderWidth:1,borderColor:theme.colors.border,borderRadius:7,backgroundColor:theme.colors.surface1,shadowColor:'#000',shadowOpacity:.18,shadowRadius:8,zIndex:200}}>
  <ScrollView keyboardShouldPersistTaps="handled" style={{flexShrink:1}}><View onLayout={e=>setHeight(e.nativeEvent.layout.height+2)}>{children}</View></ScrollView>
 </View>;
}
