import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveFixture } from './helpers/archive-service.ts';
import { basketSelections, changeMessage } from '../client/topic-selection.ts';
import { pendingTopicAssets, topicDisplayMessages } from '../client/topic-asset-state.ts';

test('display refresh updates exact existing asset IDs while the material basket stays frozen', () => {
  const topic = structuredClone(archiveFixture().topics[0]), message = topic.messages[0];
  message.assets = [{ id: 'image-1', state: 'pending', name: 'attachment', mimeType: 'application/octet-stream' }];
  const basket = changeMessage({}, topic, message), selected = basketSelections(basket), original = JSON.stringify(basket);
  const fresh = structuredClone(message);
  fresh.assets[0] = { ...fresh.assets[0], state: 'ready', name: '图片.png', mimeType: 'image/png', size: 1234 };
  fresh.assets.push({ id: 'late-image', state: 'ready', name: 'later.png', mimeType: 'image/png' });
  const display = topicDisplayMessages([fresh], basket[topic.id].topic.messages);
  const shown = display.find(item => item.id === message.id)!;
  assert.equal(shown.assets[0].state, 'ready');
  assert.equal(shown.assets[0].name, '图片.png');
  assert.deepEqual(shown.assets.map(asset => asset.id), ['image-1']);
  assert.equal(shown.text, message.text); assert.equal(shown.version, message.version);
  assert.deepEqual(basketSelections(basket), selected);
  assert.equal(JSON.stringify(basket), original);
  assert.equal(selected[0].assets.length, 0, 'newly ready images require an explicit selection');
});

test('a new message version or another source never overwrites a selected historical original', () => {
  const message = structuredClone(archiveFixture().topics[0].messages[0]);
  message.assets[0].state = 'pending';
  for (const change of [{ version: 'new-version' }, { sourceId: 'another-source' }, { channelId: 'another-group' }, { archiveId: 'another-archive' }]) {
    const fresh = { ...structuredClone(message), ...change, text: 'changed original' };
    fresh.assets[0].state = 'ready';
    const display = topicDisplayMessages([fresh], [message]);
    assert.equal(display[0], message);
    assert.equal(display[0].assets[0].state, 'pending');
  }
});

test('only unresolved media requires background readiness checks in topic and context reads', () => {
  const { topics } = archiveFixture();
  assert.equal(pendingTopicAssets(topics[0]), false);
  assert.equal(pendingTopicAssets(topics[1]), true);
  assert.equal(pendingTopicAssets({ items: topics[1].messages }), true);
  assert.equal(pendingTopicAssets(), false);
  const ready = structuredClone(topics[1]); ready.messages[0].assets[0].state = 'ready';
  assert.equal(pendingTopicAssets(ready), false);
  ready.messages[0].assets[0] = { ...ready.messages[0].assets[0], state: 'pending', kind: 'avatar' };
  assert.equal(pendingTopicAssets(ready), false);
});
