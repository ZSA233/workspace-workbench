import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePathPattern, createFileClassifier, DEFAULT_TEST_RULES, filterChangedFiles, nextVisibleFile, pathFilterMatcher, registerTestFilePreset, validateTestRules } from '../shared/change-file-filter.ts';
import { anchoredRowOffset } from '../client/change-list-window.ts';
import { filterPopoverPlacement } from '../client/file-filter-popover.ts';

test('language presets recognize test source, including root and nested paths', () => {
  const classify = createFileClassifier();
  for (const path of ['cache_test.go', 'internal/cache_test.go', 'test_report.py', 'pkg/report_test.py', 'app.test.ts', 'ui/view.spec.tsx', 'client/a.test.mjs', '__tests__/a.js', 'pkg/__tests__/deep/a.ts', 'src/test/java/MainTest.java', 'api/src/test/kotlin/Test.kt', 'app/src/androidTest/java/Test.java']) {
    assert.equal(classify(path).test, true, path); assert.ok(classify(path).presetId, path);
  }
});

test('test substrings, assets, snapshots, examples and unrelated extensions remain normal', () => {
  const classify = createFileClassifier();
  for (const path of ['latest.go', 'contest.py', 'tests/report.py', 'test.config.json', 'test_report.txt', 'app.test.css', '__tests__/sample.json', '__tests__/__snapshots__/a.test.ts', 'testdata/cache_test.go', 'fixtures/test_report.py', 'examples/app.spec.ts', 'src/test/resources/config.xml', 'src/main/java/Test.java']) assert.equal(classify(path).test, false, path);
});

test('custom normal rules override custom tests and presets, and disabled presets stay independent', () => {
  const classify = createFileClassifier({ disabledPresets: ['go'], testPatterns: ['special/**', 'testdata/**'], normalPatterns: ['special/production.go', 'report_test.py'] });
  assert.equal(classify('cache_test.go').test, false);
  assert.equal(classify('test_report.py').test, true);
  assert.equal(classify('special/case.go').source, 'project-test');
  assert.equal(classify('testdata/case.txt').test, true);
  assert.equal(classify('special/production.go').source, 'project-normal');
  assert.equal(classify('report_test.py').test, false);
});

test('a registered non-language preset uses the same classifier and reports its matching rule', () => {
  const retire = registerTestFilePreset({ id: 'contract-fixture', label: 'Fixture', labelZh: '示例', patterns: ['*.check.custom'] });
  try {
    assert.deepEqual(createFileClassifier()('model.check.custom'), { test: true, source: 'preset', presetId: 'contract-fixture', pattern: '*.check.custom' });
    assert.throws(() => registerTestFilePreset({ id: 'contract-fixture', label: '', labelZh: '', patterns: [] }));
  } finally { retire(); }
  assert.equal(createFileClassifier()('model.check.custom').test, false);
});

test('path patterns support globstar at zero or multiple levels and basename-only matching', () => {
  for (const path of ['a.go', 'pkg/a.go', 'a/b/c.go']) assert.equal(compilePathPattern('**/*.go')(path), true);
  assert.equal(compilePathPattern('internal/**')('internal/cache/a.go'), true);
  assert.equal(compilePathPattern('internal/**')('other/internal/a.go'), false);
  assert.equal(compilePathPattern('*_test.go')('internal/cache_test.go'), true);
  assert.equal(compilePathPattern('a?.go')('pkg/ab.go'), true);
  assert.equal(compilePathPattern('a?.go')('pkg/abc.go'), false);
  assert.equal(compilePathPattern('a[1].go')('a[1].go'), true);
  assert.equal(compilePathPattern('a[1].go')('a1.go'), false);
});

test('invalid path patterns are rejected without executing user regex', () => {
  for (const pattern of ['', '/root/**', '../cache/**', 'a/**b', 'a//b', 'a\0b', '*'.repeat(513)]) assert.throws(() => compilePathPattern(pattern), pattern);
  assert.throws(() => validateTestRules({ ...DEFAULT_TEST_RULES, testPatterns: Array(129).fill('*.go') }));
  const pattern = Array(80).fill('*a').join('') + 'z';
  assert.equal(compilePathPattern(pattern)('a'.repeat(300)), false);
});

test('text matching considers old and new paths, with exclusion taking priority', () => {
  const matches = pathFilterMatcher({ include: 'INTERNAL', exclude: 'vendor', matchMode: 'text' });
  assert.equal(matches({ path: 'internal/cache.go' }), true);
  assert.equal(matches({ path: 'src/cache.go', oldPath: 'internal/cache.go' }), true);
  assert.equal(matches({ path: 'internal/cache.go', oldPath: 'vendor/cache.go' }), false);
  assert.equal(pathFilterMatcher({ include: 'Internal/**', exclude: '', matchMode: 'glob' })({ path: 'internal/cache.go' }), false);
});

test('hiding tests retains original order, classifies renames by their new path and preserves raw results', () => {
  const files = [{ path: 'z.go', oldPath: 'z_test.go' }, { path: 'b_test.go' }, { path: 'a.go' }];
  const result = filterChangedFiles(files, { include: '', exclude: '', matchMode: 'text' }, 'hide', createFileClassifier());
  assert.deepEqual(result.files.map(f => f.path), ['z.go', 'a.go']); assert.equal(result.hiddenTests, 1);
  assert.equal(result.classifications.get('z.go')?.test, false); assert.equal(files.length, 3);
  assert.equal(filterChangedFiles(files, { include: '', exclude: '', matchMode: 'text' }, 'dim', createFileClassifier()).files.length, 3);
});

test('hidden-test counts respect include, exclude and explanation filters', () => {
  const files = ['a_test.go', 'b_test.go', 'b.go', 'other.py'].map(path => ({ path }));
  const result = filterChangedFiles(files, { include: 'b', exclude: '', matchMode: 'text' }, 'hide', createFileClassifier(), path => path !== 'b.go');
  assert.deepEqual(result.files, []); assert.equal(result.hiddenTests, 1); assert.equal(result.total, 4);
});

test('navigation keeps visible files or chooses next, previous, or an empty state deterministically', () => {
  const all = ['a', 'b', 'c', 'd'];
  assert.equal(nextVisibleFile(all, ['a', 'c'], 'a'), 'a');
  assert.equal(nextVisibleFile(all, ['a', 'c'], 'b'), 'c');
  assert.equal(nextVisibleFile(all, ['a', 'c'], 'd'), 'c');
  assert.equal(nextVisibleFile(all, [], 'd'), '');
});

test('mixed-height list anchoring retains a surviving row and its pixel position', () => {
  assert.equal(anchoredRowOffset(['dir', 'test', 'source', 'tail'], [0, 29, 59, 89, 119], ['dir', 'source', 'tail'], [0, 29, 59, 89], 65), 35);
  assert.equal(anchoredRowOffset(['dir', 'test', 'source'], [0, 29, 59, 89], ['dir', 'source'], [0, 29, 59], 35), 29);
  assert.equal(anchoredRowOffset([], [0], [], [0], 50), 0);
});

test('filter popover stays inside narrow owner panels and avoids the bottom edge', () => {
  for (const ownerWidth of [180, 280, 390, 800]) for (const y of [40, 600, 850]) {
    const placement = filterPopoverPlacement({ x: 300 + ownerWidth - 28, y, width: 28, height: 28 }, { x: 300, width: ownerWidth }, { width: 1400, height: 900 });
    assert.ok(placement.left >= 300); assert.ok(placement.left + placement.width <= 300 + ownerWidth);
    assert.ok(placement.top >= 8); assert.ok(placement.top + placement.maxHeight <= 900);
  }
  const constrained=filterPopoverPlacement({x:660,y:600,width:28,height:28},{x:320,y:35,width:390,height:760},{width:1200,height:1000});
  assert.ok(constrained.top>=39);assert.ok(constrained.top+constrained.maxHeight<=791);
});
