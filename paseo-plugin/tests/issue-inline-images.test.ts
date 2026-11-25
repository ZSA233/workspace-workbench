import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { archiveFixture } from './helpers/archive-service.ts';
import { issueDetailSchema } from '../shared/extensions/project-communications/issues.ts';
import { issueAssets, issueAssetSelectable, issueTextParts } from '../shared/extensions/project-communications/issue-assets.ts';
import { changeIssuePart, issuePartSelectable, issuePartSelected, selectIssue } from '../client/issue-selection.ts';

const id = (name: string) => createHash('sha256').update(name).digest('hex');
function fixture() {
  const issue = archiveFixture().issues[0], comment = issue.comments[0];
  issue.attachments = []; issue.attachmentsState = 'empty';
  issue.body = '🚀甲乙尾';
  issue.inlineImages = [
    { id: id('body'), name: '正文截图.png', state: 'ready', offset: 2 },
    { id: id('body'), name: '正文截图.png', state: 'ready', offset: 4 },
    { id: id('comment'), name: '评论截图.png', state: 'ready', offset: 1, commentId: comment.id },
    { id: id('pending'), name: '等待图片.png', state: 'pending', offset: 0 },
    { id: id('orphan'), name: '其他评论.png', state: 'ready', offset: 0, commentId: id('missing-comment') },
  ];
  return issue;
}

test('inline placements retain Unicode positions and duplicate placements share one versioned original', () => {
  const issue = issueDetailSchema.parse(fixture());
  assert.equal(issue.inlineImages?.length, 5);
  const body = issue.inlineImages!.filter(image => !image.commentId && image.state === 'ready');
  const parts = issueTextParts(issue.body, body);
  assert.equal(parts[0].text, '🚀甲');
  assert.equal(parts[1].text, '乙尾');
  assert.equal(parts.map(part => part.text).join(''), issue.body);
  assert.equal(parts.flatMap(part => part.images).length, 2);
  assert.deepEqual(issueAssets(issue).map(asset => asset.id), [id('body'), id('comment'), id('pending')]);
  assert.ok(issueAssets(issue).every(asset => asset.version === issue.version && asset.kind === 'image'));
  const legacy = archiveFixture().issues[0];
  assert.equal(issueDetailSchema.parse(legacy).inlineImages, undefined);
  assert.deepEqual(issueAssets(legacy), legacy.attachments);
});

test('text selection includes its ready inline originals and image selection remains independent', () => {
  const issue = fixture(), comment = issue.comments[0];
  let basket = changeIssuePart({}, issue, { kind: 'body' });
  assert.equal(basket[issue.id].selection.body, true);
  assert.deepEqual(basket[issue.id].selection.attachments, [{ id: id('body'), version: issue.version }]);
  basket = changeIssuePart(basket, issue, { kind: 'body' });
  assert.equal(basket[issue.id].selection.body, false);
  assert.equal(basket[issue.id].selection.attachments.length, 1);
  basket = changeIssuePart(basket, issue, { kind: 'comments', id: comment.id, version: comment.version });
  assert.deepEqual(basket[issue.id].selection.comments, [{ id: comment.id, version: comment.version }]);
  assert.deepEqual(basket[issue.id].selection.attachments.map(asset => asset.id), [id('body'), id('comment')]);
  const selected = selectIssue({}, issue)[issue.id].selection;
  assert.equal(selected.attachments.length, 2);
  assert.equal(selected.comments.length, 0);
  const refreshed = structuredClone(issue); refreshed.version = 'revision-2';
  refreshed.inlineImages!.push({ id: id('late'), name: '新图片.png', state: 'ready', offset: 0 });
  assert.equal(changeIssuePart(basket, refreshed, { kind: 'body' }), basket);
  assert.equal(basket[issue.id].selection.attachments.some(asset => asset.id === id('late')), false);
  assert.equal(issuePartSelectable(issue, { kind: 'comments', id: id('unknown'), version: 'unknown' }), false);
  issue.commentsState = 'unavailable';
  assert.equal(issueAssetSelectable(issue, issueAssets(issue).find(asset => asset.id === id('comment'))!), false);
});

test('image-only descriptions and comments select original images without inventing empty text references', () => {
  const issue = fixture(), comment = issue.comments[0];
  issue.body = ''; issue.bodyState = 'empty'; comment.text = '';
  let basket = changeIssuePart({}, issue, { kind: 'body' });
  assert.equal(basket[issue.id].selection.body, false);
  assert.equal(issuePartSelected(issue, basket[issue.id].selection, { kind: 'body' }), true);
  basket = changeIssuePart(basket, issue, { kind: 'body' });
  assert.deepEqual(basket, {});
  const part = { kind: 'comments' as const, id: comment.id, version: comment.version };
  basket = changeIssuePart({}, issue, part);
  assert.deepEqual(basket[issue.id].selection.comments, []);
  assert.deepEqual(basket[issue.id].selection.attachments, [{ id: id('comment'), version: issue.version }]);
  assert.equal(issuePartSelected(issue, basket[issue.id].selection, part), true);
  assert.deepEqual(changeIssuePart(basket, issue, part), {});
});
