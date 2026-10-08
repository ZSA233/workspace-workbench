/** A view-local signal: only the rail and viewport subscribe to pixel offsets. */
export function createScrollSignal(initial=0){
 let value=initial,frame:ReturnType<typeof setTimeout>|number|undefined;
 const listeners=new Set<()=>void>();
 const publish=()=>{frame=undefined;for(const listener of listeners)listener();};
 return {
  get:()=>value,
  subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
  set:(next:number)=>{if(next===value||!Number.isFinite(next))return;value=next;if(frame===undefined)frame=typeof requestAnimationFrame==='function'?requestAnimationFrame(publish):setTimeout(publish,16);},
  dispose:()=>{if(frame!==undefined){if(typeof cancelAnimationFrame==='function')cancelAnimationFrame(frame as number);else clearTimeout(frame);}frame=undefined;listeners.clear();},
 };
}
export type ScrollSignal=ReturnType<typeof createScrollSignal>;
