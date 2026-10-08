/** Layout only: explanation panels never participate in Diff row measurement. */
export type NoteRect={x:number;y:number;width:number;height:number};
export type NoteDraft={text:string;kind:'question'|'confirm'|null;management?:import('../shared/change-notes').NoteManagementInput};
export function notePopoverPlacement(bounds:NoteRect,anchor:NoteRect,height:number,sheet:boolean){
 const margin=8,width=Math.max(0,Math.min(320,bounds.width-margin*2));
 const h=Math.min(height,Math.max(0,bounds.height-margin*2));
 if(sheet)return {left:margin,top:Math.max(margin,bounds.height-h-margin),width:Math.max(0,bounds.width-margin*2),maxHeight:Math.max(0,bounds.height-margin*2)};
 const x=anchor.x-bounds.x,y=anchor.y-bounds.y;
 const right=x+anchor.width+12;
 const beside=right+width<=bounds.width-margin;
 const top=beside?y:y+anchor.height+8+h<=bounds.height-margin?y+anchor.height+8:y-h-8;
 return {left:Math.max(margin,Math.min(beside?right:x,bounds.width-width-margin)),top:Math.max(margin,Math.min(top,bounds.height-h-margin)),width,maxHeight:Math.max(0,bounds.height-margin*2)};
}
export function noteAnchorVisible(anchor:NoteRect,bounds:NoteRect){return anchor.width>0&&anchor.height>0&&anchor.y+anchor.height>bounds.y+36&&anchor.y<bounds.y+bounds.height&&anchor.x+anchor.width>bounds.x&&anchor.x<bounds.x+bounds.width;}
/** Bounded rendering handoff, including hosts without a global animation-frame API. */
export function scheduleNoteFrame(callback:()=>void):()=>void {
 if(typeof requestAnimationFrame==='function'&&typeof cancelAnimationFrame==='function'){
  const frame=requestAnimationFrame(callback);return()=>cancelAnimationFrame(frame);
 }
 const timer=setTimeout(callback,16);return()=>clearTimeout(timer);
}
