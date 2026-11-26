import assert from 'node:assert/strict';
import test from 'node:test';
import { topicTargetKey, topicTargetMatches, topicTargetTitle } from '../client/topic-target-choice.ts';
import type { TopicTarget } from '../shared/extensions/project-communications/topics.ts';

test('renamed session titles display and match searches while the original title remains searchable', () => {
  const target: TopicTarget = { id: 'session:agent-a', kind: 'session', agentId: 'agent-a', workspaceId: 'host-a',
    title: '【币商中心】浏览器端支持', sessionTitle: 'Please review the payment flow', provider: 'codex', model: 'Review Model' };
  assert.equal(topicTargetTitle(target, {}), target.title);
  for (const query of ['币商中心', '  浏览器端  ', 'PAYMENT', 'CODEX', 'review model', '   ']) {
    assert.equal(topicTargetMatches(target, query, {}), true, query);
  }
  assert.equal(topicTargetMatches(target, '不存在的标题', {}), false);
  assert.equal(topicTargetKey(target), 'session:agent-a');
});

test('legacy targets retain Workbench names and identity when host metadata is absent', () => {
  const target: TopicTarget = { workspaceId: 'worktree-a', agentId: 'agent-a' }, names = { 'worktree-a': '客户反馈修复' };
  assert.equal(topicTargetTitle(target, names), names['worktree-a']);
  assert.equal(topicTargetMatches(target, '客户反馈', names), true);
  assert.equal(topicTargetTitle(target, {}), target.agentId);
  assert.equal(topicTargetKey(target), 'workspace:worktree-a');
});
