import test from 'node:test';
import assert from 'node:assert/strict';
import {notePopoverPlacement,noteAnchorVisible} from '../client/note-popover-model.ts';
test('popover prefers right-side space and stays inside the reading region',()=>{
 const bounds={x:300,y:80,width:1000,height:700};
 assert.equal(notePopoverPlacement(bounds,{x:450,y:200,width:100,height:22},180,false).left,262);
 for(const width of [280,320,480,720,1000])for(const y of [80,390,760]){
  const area={...bounds,width};const p=notePopoverPlacement(area,{x:300+width-20,y,width:15,height:22},190,width<480);
  assert.ok(p.left>=0&&p.left+p.width<=width);assert.ok(p.top>=0&&p.top+190<=700);
 }
});
test('offscreen and recycled anchors do not claim a visible code location',()=>{
 const area={x:300,y:80,width:700,height:500};
 assert.equal(noteAnchorVisible({x:300,y:200,width:22,height:22},area),true);
 assert.equal(noteAnchorVisible({x:300,y:0,width:22,height:22},area),false);
 assert.equal(noteAnchorVisible({x:300,y:700,width:22,height:22},area),false);
 assert.equal(noteAnchorVisible({x:300,y:200,width:0,height:0},area),false);
});

test('render handoff can be cancelled without an animation-frame host',async t=>{
 const {scheduleNoteFrame}=await import('../client/note-popover-model.ts');
 t.mock.timers.enable({apis:['setTimeout']});
 let calls=0;
 const cancel=scheduleNoteFrame(()=>calls++);cancel();t.mock.timers.tick(32);assert.equal(calls,0);
 scheduleNoteFrame(()=>calls++);t.mock.timers.tick(16);assert.equal(calls,1);
});
