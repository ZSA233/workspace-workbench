import {createElement,memo} from 'react';
import {View} from 'react-native';
import {iconGeometry,iconShapes} from './icon-shapes';
import {reportNativeDiagnostic} from './native-diagnostics';
export const GeometricIcon=memo(function GeometricIcon({name,size=16,color='#9ca3af'}:{name:string;size?:number;color?:string}){
 if(!iconShapes[name])reportNativeDiagnostic('unknown-icon',{name});
 const scale=size/24,stroke=Math.max(1,size/12);
 return createElement(View,{pointerEvents:'none',accessible:false,testID:`geometric-icon-${name}`,style:{width:size,height:size}},iconGeometry(name).map((part,i)=>{
   const style=part.kind==='line'?{
     left:(part.x1+part.x2)/2*scale-Math.hypot(part.x2-part.x1,part.y2-part.y1)*scale/2,
     top:(part.y1+part.y2)/2*scale-stroke/2,width:Math.hypot(part.x2-part.x1,part.y2-part.y1)*scale,height:stroke,
     borderRadius:stroke/2,backgroundColor:color,transform:[{rotate:`${Math.atan2(part.y2-part.y1,part.x2-part.x1)*180/Math.PI}deg`}],
   }:{left:part.x*scale,top:part.y*scale,width:part.w*scale,height:part.h*scale,borderRadius:(part.r||0)*scale,borderWidth:part.fill?0:stroke,borderColor:color,backgroundColor:part.fill?color:'transparent'};
   return createElement(View,{key:i,style:{position:'absolute',...style}});
 }));
});
