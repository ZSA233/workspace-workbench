import {memo,useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {Platform,View} from 'react-native';
import type {PluginWorkspacePanelProps} from '@getpaseo/plugin/client';
import type {DiffOverviewMarker} from '../model';
import type {ScrollSignal} from '../diff-scroll-store';
import {clamp,railWidth,railMetrics,railMarks,markerAt,trackOffset,dragOffset,keyOffset,type RailMark} from '../diff-scroll-model';
import {copy} from '../../shared/copy';
import {observerAccent} from '../theme';
export type OverviewRailProps={
 contentHeight:number;height:number;lineHeight?:number;width?:number;markers:DiffOverviewMarker[];scroll:ScrollSignal;
 theme:PluginWorkspacePanelProps['theme'];onSelectRow(index:number):void;onOffset(offset:number):void;
 onInteractionStart():void;onDragStateChange(dragging:boolean):void;active:boolean;layoutIdentity:unknown;
};
type Gesture={top:number;start:number;last:number;grab:number;thumb:boolean;dragged:boolean;height:number;content:number;markers:DiffOverviewMarker[]};
const Paint=memo(function Paint({marks,colors}:{marks:RailMark[];colors:{added:string;removed:string;modified:string}}){
 return <>{marks.map(mark=>Platform.OS==='web'?<div key={`${mark.first}:${mark.kind}`} data-testid={`diff-overview-marker-${mark.first}`} data-start-row={mark.row} style={{position:'absolute',right:7,top:mark.top,width:7,height:mark.height,borderRadius:1.5,backgroundColor:colors[mark.kind]}}/>:<View key={`${mark.first}:${mark.kind}`} pointerEvents="none" testID={`diff-overview-marker-${mark.first}`} style={{position:'absolute',right:7,top:mark.top,width:7,height:mark.height,borderRadius:1.5,backgroundColor:colors[mark.kind]}}/>)}</>;
});
/** A wide interaction surface around a narrow paint layer; only this component tracks pixels. */
export const OverviewRail=memo(function OverviewRail(props:OverviewRailProps){
 const native=Platform.OS!=='web',width=props.width??railWidth(native),offset=useSyncExternalStore(props.scroll.subscribe,props.scroll.get),latest=useRef(props);latest.current=props;
 const [hover,setHover]=useState(false),[pressed,setPressed]=useState(false),gesture=useRef<Gesture|null>(null),root=useRef<any>(null);
 const metrics=railMetrics(props.contentHeight,props.height,offset),marks=useMemo(()=>railMarks(props.markers,props.height),[props.markers,props.height]);
 const colors=useMemo(()=>({added:props.theme.colors.statusSuccess,removed:props.theme.colors.statusDanger,modified:observerAccent(props.theme)}),[props.theme]);
 function finish(){const old=gesture.current;gesture.current=null;setPressed(false);if(old?.dragged)latest.current.onDragStateChange(false);}
 function start(pageY:number,top:number){
  if(!Number.isFinite(pageY)||!Number.isFinite(top))return;
  const p=latest.current,m=railMetrics(p.contentHeight,p.height,p.scroll.get()),y=pageY-top;
  p.onInteractionStart();gesture.current={top,start:y,last:y,grab:y-m.thumbTop,thumb:y>=m.thumbTop&&y<=m.thumbTop+m.thumbHeight,dragged:false,height:p.height,content:p.contentHeight,markers:p.markers};setPressed(true);
 }
 function move(pageY:number){
  const g=gesture.current;if(!g||!Number.isFinite(pageY))return;const y=pageY-g.top;g.last=y;
  if(!g.dragged&&Math.abs(y-g.start)<(width>=44?6:4))return;
  if(!g.dragged){g.dragged=true;if(!g.thumb)g.grab=railMetrics(g.content,g.height,0).thumbHeight/2;latest.current.onDragStateChange(true);}
  latest.current.onOffset(dragOffset(y,g.grab,g.content,g.height));
 }
 function release(pageY:number){
  const g=gesture.current;if(!g)return;if(!Number.isFinite(pageY)){finish();return;}
  if(g.dragged)move(pageY);
  else{const y=pageY-g.top,marker=markerAt(g.markers,g.height,y,width>=44?8:4);if(marker)latest.current.onSelectRow(marker.startRow);else latest.current.onOffset(trackOffset(y,g.content,g.height));}
  finish();
 }
 const finishRef=useRef(finish);finishRef.current=finish;
 useEffect(()=>{if(!props.active)finishRef.current();},[props.active]);
 useEffect(()=>{finishRef.current();},[props.layoutIdentity,props.height]);
 useEffect(()=>{if(Platform.OS!=='web')return;const win=(globalThis as any).window;if(!win)return;const stop=()=>finishRef.current();win.addEventListener('blur',stop);return()=>win.removeEventListener('blur',stop);},[]);
 useEffect(()=>()=>{const g=gesture.current;gesture.current=null;if(g?.dragged)latest.current.onDragStateChange(false);},[]);
 if(props.height<=0)return null;
 const thumbStyle={position:'absolute' as const,right:2,top:metrics.thumbTop,width:hover||pressed?5:3,height:metrics.thumbHeight,borderRadius:3,backgroundColor:props.theme.colors.foregroundMuted,opacity:hover||pressed?1:.55};
 if(!native)return <div ref={root} data-testid="diff-overview-rail" role="scrollbar" aria-label={copy.diffOverview} aria-orientation="vertical" aria-valuemin={0} aria-valuemax={Math.round(metrics.maxScroll)} aria-valuenow={Math.round(clamp(offset,0,metrics.maxScroll))} tabIndex={0}
  style={{position:'absolute',right:0,top:0,width,height:props.height,zIndex:7,backgroundColor:props.theme.colors.surface2,touchAction:'none',userSelect:'none',cursor:pressed?'grabbing':'default',outlineOffset:-2}}
  onPointerEnter={()=>setHover(true)} onPointerLeave={()=>setHover(false)} onFocus={()=>setHover(true)} onBlur={()=>{setHover(false);finish();}}
  onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();(e.currentTarget as any).focus({preventScroll:true});(e.currentTarget as any).setPointerCapture(e.pointerId);start(e.clientY,(e.currentTarget as any).getBoundingClientRect().top);}}
  onPointerMove={e=>move(e.clientY)} onPointerUp={e=>{release(e.clientY);if((e.currentTarget as any).hasPointerCapture(e.pointerId))(e.currentTarget as any).releasePointerCapture(e.pointerId);}} onPointerCancel={finish} onLostPointerCapture={finish}
  onKeyDown={e=>{if(e.key==='Escape'){finish();return;}const next=keyOffset(e.key,props.scroll.get(),props.contentHeight,props.height,props.lineHeight);if(next!==null){e.preventDefault();props.onInteractionStart();props.onOffset(next);}}}>
  <Paint marks={marks} colors={colors}/>{metrics.maxScroll>0?<div data-testid="diff-overview-thumb" style={{...thumbStyle,pointerEvents:'none'}}/>:null}
 </div>;
 return <View ref={root} testID="diff-overview-rail" accessible accessibilityRole="adjustable" accessibilityLabel={copy.diffOverview} accessibilityValue={{min:0,max:Math.round(metrics.maxScroll),now:Math.round(clamp(offset,0,metrics.maxScroll))}} accessibilityActions={[{name:'increment'},{name:'decrement'}]} onAccessibilityAction={e=>{props.onInteractionStart();props.onOffset(keyOffset(e.nativeEvent.actionName==='increment'?'PageDown':'PageUp',offset,props.contentHeight,props.height)!);}}
  onStartShouldSetResponder={()=>true} onMoveShouldSetResponder={()=>true} onResponderGrant={e=>start(e.nativeEvent.pageY,e.nativeEvent.pageY-e.nativeEvent.locationY)} onResponderMove={e=>move(e.nativeEvent.pageY)} onResponderRelease={e=>release(e.nativeEvent.pageY)} onResponderTerminate={finish} onResponderTerminationRequest={()=>!gesture.current?.dragged}
  style={{position:'absolute',right:0,top:0,width,height:props.height,zIndex:7,backgroundColor:props.theme.colors.surface2}}>
  <View pointerEvents="none" style={{position:'absolute',left:0,right:0,top:0,bottom:0}}><Paint marks={marks} colors={colors}/>{metrics.maxScroll>0?<View testID="diff-overview-thumb" style={thumbStyle}/>:null}</View>
 </View>;
});
