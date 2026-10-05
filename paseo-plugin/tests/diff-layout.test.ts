import test from 'node:test';
import assert from 'node:assert/strict';
import {changedFragment,highlightReplacements,measuredDiffRows} from '../client/diff-layout.ts';
import {parseUnifiedPatch,buildDiffDisplayRows} from '../client/model.ts';
test('inline replacement highlight preserves content and measured wrapping changes offsets',()=>{
 assert.deepEqual(changedFragment('timeout(3)','timeout(5)'),[8,9]);
 const parsed=highlightReplacements(parseUnifiedPatch('@@ -1 +1 @@\n-timeout(3)\n+timeout(5)\n'));
 assert.equal(parsed.hunks[0].lines[0].content,'timeout(3)');assert.deepEqual(parsed.hunks[0].lines[1].inlineChange,[8,9]);
 const rows=buildDiffDisplayRows(parsed,'unified');const normal=measuredDiffRows(rows,14),wrapped=measuredDiffRows(rows,14,{[rows[1].key]:66});
 assert.equal(wrapped.offsets[2]-normal.offsets[2],44);assert.equal(measuredDiffRows(rows,18).lengths[1],26);
});
