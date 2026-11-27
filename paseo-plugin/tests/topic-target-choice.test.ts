import assert from 'node:assert/strict';
import test from 'node:test';
import { topicTargetKey, topicTargetMatches, topicTargetTitle,resolveTopicTarget } from '../client/topic-target-choice.ts';
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
test('visible native conversations take precedence over remembered delivery targets and top Workbench selections',()=>{
 const a:TopicTarget={id:'session:a',kind:'session',agentId:'a',workspaceId:'host-a'},b:TopicTarget={id:'session:b',kind:'session',agentId:'b',workspaceId:'host-b'},work:TopicTarget={agentId:'worker',workspaceId:'worktree'};
 const targets=[a,b,work];assert.equal(resolveTopicTarget(targets,{rememberedId:a.id,currentAgentId:'b',currentWorkspaceId:'worktree'}),b);
 assert.equal(resolveTopicTarget(targets,{rememberedId:a.id,currentHostWorkspaceId:'host-b'}),b);
 assert.equal(resolveTopicTarget(targets,{rememberedId:a.id,currentHostWorkspaceId:'host-a'}),a);
 assert.equal(resolveTopicTarget(targets,{rememberedId:a.id,currentHostWorkspaceId:'host-b',manualId:a.id}),a);
 assert.equal(resolveTopicTarget(targets,{rememberedId:a.id}),a);
 assert.equal(resolveTopicTarget(targets,{rememberedId:a.id,currentHostWorkspaceId:'unavailable'}),undefined);
 assert.equal(resolveTopicTarget(targets,{rememberedId:a.id,currentAgentId:'unavailable'}),undefined);
 assert.equal(resolveTopicTarget(targets,{manualId:'removed',currentHostWorkspaceId:'host-b'}),undefined);
});
