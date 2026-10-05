import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDiffDisplayRows,buildDiffOverviewMarkers,parseUnifiedPatch} from '../client/model.ts';
import {measuredDiffRows} from '../client/diff-layout.ts';
const patch=parseUnifiedPatch(['@@ -1,8 +1,8 @@',' before','-first removed','+first added',' between',' after','-second removed','+second added',' tail'].join('\n'));
test('overview tracks measured wrap heights and exposes the exact changed row within a hunk',()=>{
 const rows=buildDiffDisplayRows(patch,'unified');const heights={[rows[1].key]:176,[rows[2].key]:66,[rows[4].key]:88};
 const metrics=measuredDiffRows(rows,14,heights),markers=buildDiffOverviewMarkers(rows,metrics);
 assert.equal(markers.length,2);assert.equal(markers[0].hunkIndex,markers[1].hunkIndex);
 assert.equal(markers[0].startRow,2);assert.equal(markers[1].startRow,6);assert.equal(markers[0].endRow,3);
 for(const marker of markers){assert.equal(marker.position,metrics.offsets[marker.startRow]/metrics.contentHeight);assert.equal(marker.extent,(metrics.offsets[marker.endRow]+metrics.lengths[marker.endRow]-metrics.offsets[marker.startRow])/metrics.contentHeight);}
 assert.notEqual(markers[0].position,buildDiffOverviewMarkers(rows)[0].position);
});
test('font sizes and split compression use the same coordinate system as their own viewport',()=>{
 for(const mode of ['unified','split'] as const)for(const font of [12,14,16,18]){
  const rows=buildDiffDisplayRows(patch,mode),metrics=measuredDiffRows(rows,font),markers=buildDiffOverviewMarkers(rows,metrics);
  assert.equal(markers.length,2);assert.ok(markers.every(m=>m.startRow>0&&m.position>=0&&m.position+m.extent<=1));
  for(const marker of markers)assert.ok(Math.abs(marker.position*metrics.contentHeight-metrics.offsets[marker.startRow])<1e-8);
 }
});
