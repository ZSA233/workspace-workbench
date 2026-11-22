import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveFixture } from './helpers/archive-service.ts';
import { basketCounts, basketSelections, changeAsset, changeMessage, editSelectedMessage,selectTopic } from '../client/topic-selection.ts';

test('late messages and originals never expand an already selected topic', () => {
  const { topics } = archiveFixture(), topic = topics[0];
  const basket = selectTopic({}, topic);
  const changed = structuredClone(topic);
  changed.messages.push({ ...topic.messages[0], id: 'late-message', assets: [{ id: 'late-image', state: 'ready', name: 'new.png', mimeType: 'image/png' }] });
  assert.deepEqual(basketCounts(basket), { topics: 1, messages: 2, assets: 2 });
  assert.equal(basketSelections(basket)[0].messages.some(message => message.id === 'late-message'), false);
  assert.equal(basketSelections(basket)[0].includeAnalysis, false);
});
test('message and original-image selection are independent and context keeps its anchor', () => {
  const { topics, context } = archiveFixture(), topic = topics[0];
  let basket = selectTopic({}, topic);
  basket = changeMessage(basket, topic, topic.messages[0]);
  assert.deepEqual(basketCounts(basket), { topics: 1, messages: 1, assets: 2 });
  basket = changeAsset(basket, topic, topic.messages[0], topic.messages[0].assets[0]);
  basket = changeMessage(basket, topic, context, topic.messages[0].id);
  assert.equal(basketSelections(basket)[0].messages.find(message => message.id === context.id)?.contextOf, topic.messages[0].id);
  assert.deepEqual(basketCounts(basket), { topics: 1, messages: 2, assets: 1 });
});
test('pending, unsupported and oversized attachments stay unselected', () => {
  const { topics } = archiveFixture(), topic = structuredClone(topics[1]);
  topic.messages[0].assets.push({ id: 'video', state: 'ready', name: 'movie.mp4', mimeType: 'video/mp4' },
    { id: 'large', state: 'ready', name: 'huge.png', mimeType: 'image/png', size: 10 * 1024 * 1024 });
  const basket = selectTopic({}, topic);
  assert.equal(basketCounts(basket).assets, 0);
  for (const asset of topic.messages[0].assets) assert.equal(changeAsset(basket, topic, topic.messages[0], asset), basket);
});

test('reselecting original messages preserves source chronology', () => {
  const {topics} = archiveFixture(), topic = structuredClone(topics[0]);
  topic.messages.reverse();
  let basket = selectTopic({}, topic);
  basket = changeMessage(basket, topic, topic.messages[1]);
  basket = changeMessage(basket, topic, topic.messages[1]);
  assert.deepEqual(basketSelections(basket)[0].messages.map(message => message.id), ['message-1','message-2']);
});

test('editing a selection preserves originals, survives unrelated updates and clears on explicit deselection',()=>{
  const {topics}=archiveFixture(),topic=topics[0],message=topic.messages[0],original=message.text;
  let basket=editSelectedMessage(selectTopic({},topic),message,'修正后的文字');
  assert.equal(message.text,original);assert.equal(basketSelections(basket)[0].messages[0].editedText,'修正后的文字');
  basket=changeAsset(basket,topic,message,message.assets[0]);
  assert.equal(basketSelections(basket)[0].messages[0].editedText,'修正后的文字');
  basket=changeMessage(basket,topic,message);basket=changeMessage(basket,topic,message);
  assert.equal(basketSelections(basket)[0].messages.find(item=>item.id===message.id)?.editedText,undefined);
});
