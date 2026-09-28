import assert from 'node:assert/strict';
import test from 'node:test';
import { repositoryBranchLabel, repositoryCurrentRefDetail, repositoryRefMismatch } from '../client/repository-reference.ts';
import { copy } from '../shared/copy.ts';
import { readFileSync } from 'node:fs';

const pending = { branch: '', registeredBranch: 'obs/example/schema', status: 'unknown', refState: 'unknown' as const, refCandidates: [], headShort: "", issues: [] };
test('unobserved repositories are not labeled detached or mismatched', () => {
  assert.equal(repositoryBranchLabel(pending), copy.branchUnknown);
  assert.equal(repositoryCurrentRefDetail(pending), copy.branchUnknown);
  assert.equal(repositoryRefMismatch(pending), false);
  assert.equal(repositoryBranchLabel({...pending, refState: undefined}), copy.branchUnknown);
});
test('actual attached, detached and missing states remain distinct', () => {
  assert.equal(repositoryBranchLabel({...pending, branch: 'main', refState: 'attached'}), 'main');
  assert.equal(repositoryRefMismatch({...pending, branch: 'main', refState: 'attached'}), true);
  const detached = {...pending, refState: 'detached' as const, headShort: '12345678'};
  assert.equal(repositoryBranchLabel(detached), `${copy.branchDetached} · 12345678`);
  assert.equal(repositoryCurrentRefDetail(detached), `${copy.branchDetached} · 12345678`);
  assert.equal(repositoryRefMismatch(detached), true);
  assert.equal(repositoryBranchLabel({...pending, status: 'missing'}), copy.branchMissing);
});
test('unknown repository rows without issues use a neutral dot', () => {
  const source = readFileSync(new URL('../client/components/repositories.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes('status === "unknown" && repository.issues.length === 0\n    ? theme.colors.foregroundMuted : statusColor(status, theme)'));
});
