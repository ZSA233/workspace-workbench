import type {DiffOverviewMarker} from './model.ts';
export type RowMetrics={offsets:number[];lengths:number[];contentHeight:number};
export const railWidth=(native:boolean)=>native?44:24;
export const clamp=(n:number,min:number,max:number)=>Math.min(Math.max(min,n),Math.max(min,max));
/** Index of the row containing y; no scan over the document during scroll. */
export function rowAtOffset(metrics:RowMetrics,y:number){
 let lo=0,hi=metrics.offsets.length;
 while(lo<hi){const mid=(lo+hi)>>>1;if(metrics.offsets[mid]+metrics.lengths[mid]<=y)lo=mid+1;else hi=mid;}
 return Math.min(lo,Math.max(0,metrics.offsets.length-1));
}
export function railMetrics(content:number,height:number,offset:number){
 const maxScroll=Math.max(0,content-height),thumbHeight=content>height?Math.min(height,Math.max(24,height*height/content)):height;
 const travel=Math.max(0,height-thumbHeight);
 return {maxScroll,thumbHeight,travel,thumbTop:maxScroll?clamp(offset,0,maxScroll)/maxScroll*travel:0};
}
export function trackOffset(y:number,content:number,height:number){return height>0?clamp(y/height*content-height/2,0,content-height):0;}
export function dragOffset(y:number,grab:number,content:number,height:number){const m=railMetrics(content,height,0);return m.travel?clamp(y-grab,0,m.travel)/m.travel*m.maxScroll:0;}
export function keyOffset(key:string,offset:number,content:number,height:number,lineHeight=22){
 const changes:Record<string,number>={ArrowUp:-lineHeight,ArrowDown:lineHeight,PageUp:-height*.9,PageDown:height*.9,Home:-Infinity,End:Infinity};
 return key in changes?clamp(offset+changes[key],0,content-height):null;
}
export type RailMark={top:number;height:number;kind:DiffOverviewMarker['kind'];first:number;last:number;row:number};
/** Screen-resolution paint layer. Original markers remain available for exact hit selection. */
export function railMarks(markers:DiffOverviewMarker[],height:number):RailMark[]{
 const out:RailMark[]=[];
 for(let i=0;i<markers.length;i++){
  const marker=markers[i],size=Math.min(height,Math.max(3,marker.extent*height)),top=Math.round(clamp(marker.position*height,0,height-size));
  const previous=out.at(-1);
  if(previous&&top<=previous.top+previous.height&&previous.kind===marker.kind){previous.height=Math.max(previous.height,top+size-previous.top);previous.last=i;}
  else if(previous&&top===previous.top){previous.height=Math.max(previous.height,size);previous.kind='modified';previous.last=i;}
  else out.push({top,height:size,kind:marker.kind,first:i,last:i,row:marker.startRow});
 }
 return out;
}
export function markerAt(markers:DiffOverviewMarker[],height:number,y:number,tolerance:number){
 const geometry=(i:number)=>{const size=Math.min(height,Math.max(3,markers[i].extent*height)),top=clamp(markers[i].position*height,0,height-size);return {size,top,center:top+size/2};};
 const lower=(value:number)=>{let lo=0,hi=markers.length;while(lo<hi){const mid=(lo+hi)>>>1;if(geometry(mid).center<value)lo=mid+1;else hi=mid;}return lo;};
 const next=lower(y),before=next>0?lower(geometry(next-1).center):-1;
 let best:DiffOverviewMarker|undefined,distance=Infinity;
 for(const i of [before,next]){if(i<0||i>=markers.length)continue;const frame=geometry(i),d=Math.abs(y-frame.center),marker=markers[i];
  if(y>=frame.top-tolerance&&y<=frame.top+frame.size+tolerance&&(d<distance||d===distance&&marker.startRow<(best?.startRow??Infinity))){best=marker;distance=d;}
 }
 return best;
}
