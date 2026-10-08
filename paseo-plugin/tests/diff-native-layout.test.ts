import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DIFF_CHANGE_GUTTER_STYLE} from '../client/diff-layout.ts';
const yoga=new URL('../node_modules/react-native/ReactCommon/yoga/',import.meta.url).pathname;
let compilerAvailable=true;try{execFileSync('c++',['--version'],{stdio:'ignore'});}catch{compilerAvailable=false;}
function cppFiles(path:string):string[]{return readdirSync(path,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?cppFiles(join(path,entry.name)):entry.name.endsWith('.cpp')?[join(path,entry.name)]:[]);}
test('actual Yoga: wrapped gutters follow text height instead of inflating rows to the viewport',{skip:!compilerAvailable&&'C++ compiler required for Yoga engine validation'},()=>{
 assert.equal(DIFF_CHANGE_GUTTER_STYLE.alignSelf,'stretch');assert.equal('minHeight' in DIFF_CHANGE_GUTTER_STYLE,false);
 const root=mkdtempSync(join(tmpdir(),'wb-diff-yoga-'));
 const source=`#include <yoga/Yoga.h>
#include <cstdio>
float measuredHeight=110;
YGSize measure(YGNodeConstRef,float,YGMeasureMode,float,YGMeasureMode){return {180,measuredHeight};}
void run(bool legacy,float height,float textHeight){measuredHeight=textHeight;auto root=YGNodeNew(),row=YGNodeNew(),gutter=YGNodeNew(),text=YGNodeNew();
YGNodeStyleSetWidth(root,320);YGNodeStyleSetHeight(root,height);YGNodeStyleSetFlexDirection(row,YGFlexDirectionRow);YGNodeStyleSetAlignItems(row,YGAlignStretch);
YGNodeStyleSetWidth(gutter,${DIFF_CHANGE_GUTTER_STYLE.width});YGNodeStyleSetFlexShrink(gutter,${DIFF_CHANGE_GUTTER_STYLE.flexShrink});YGNodeStyleSetAlignSelf(gutter,YGAlignStretch);if(legacy)YGNodeStyleSetMinHeightPercent(gutter,100);
YGNodeSetMeasureFunc(text,measure);YGNodeStyleSetFlexGrow(text,1);YGNodeInsertChild(root,row,0);YGNodeInsertChild(row,gutter,0);YGNodeInsertChild(row,text,1);YGNodeCalculateLayout(root,YGUndefined,YGUndefined,YGDirectionLTR);
printf("%g %g\\n",YGNodeLayoutGetHeight(row),YGNodeLayoutGetHeight(gutter));YGNodeFreeRecursive(root);}
int main(){run(true,700,110);run(false,700,110);run(false,1000,110);run(false,700,22);run(false,700,156);}`;
 try{const path=join(root,'layout.cpp'),binary=join(root,'layout');writeFileSync(path,source);
 execFileSync('c++',['-std=c++20','-I'+yoga,path,...cppFiles(join(yoga,'yoga')),'-o',binary],{timeout:60000,stdio:'pipe'});
 assert.deepEqual(execFileSync(binary,{encoding:'utf8'}).trim().split('\n'),['700 700','110 110','110 110','22 22','156 156']);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('diff renderer uses the validated gutter and resets horizontal offset in wrap mode',()=>{
 const source=readFileSync(new URL('../client/file-review.tsx',import.meta.url),'utf8');assert.match(source,/components\/diff-rendering/);const rendering=readFileSync(new URL('../client/components/diff-rendering.tsx',import.meta.url),'utf8');assert.match(rendering,/changeGutter: DIFF_CHANGE_GUTTER_STYLE/);assert.match(source,/ref=\{horizontalRef\}/);
 const controller=readFileSync(new URL('../client/use-diff-reading.ts',import.meta.url),'utf8');assert.match(controller,/if\(wrap\)horizontalRef.current\?\.scrollTo\?\.\(\{x:0,animated:false\}\)/);
});
