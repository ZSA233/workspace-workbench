import test from 'node:test';
import assert from 'node:assert/strict';
import { messageText, topicTime, topicTitle, recordAttention } from '../shared/extensions/project-communications/topics.ts';
import { archiveFixture } from './helpers/archive-service.ts';
import { basketCounts, basketSelections, changeAsset, changeMessage } from '../client/topic-selection.ts';

test('both sources lower attention for ended work and retain attention for new or reopened work', () => {
  for (const status of ['closed', 'resolved', 'completed', 'done', 'verified', '已关闭', '已解决', '已完成', '已结束', '已验证']) {
    assert.equal(recordAttention(status), 'settled', status);
  }
  for (const status of ['open', 'new', 'in_progress', 'IN-PROGRESS', 'in progress', 'reopened', '新建', '处理中', '跟进中', '重新打开', '未解决', '未关闭', '未完成']) {
    assert.equal(recordAttention(status), 'active', status);
  }
  for (const status of [undefined, '', 'paused', '待产品确认', 'not resolved', '待验证已解决情况']) {
    assert.equal(recordAttention(status), 'neutral', status);
  }
  assert.equal(recordAttention('  Resolved  '), 'settled');
});

test('archive display text and captions replace media transport markers without changing originals', () => {
  const message = archiveFixture().topics[0].messages[0];
  message.text = '[图片消息](mediaId=$opaque)联系客服未翻译\n@同事';
  message.displayText = '联系客服未翻译\n@同事';
  assert.equal(messageText(message), message.displayText);
  assert.ok(message.text.includes('mediaId=$opaque'));
  assert.equal(messageText({ ...message, text: '[视频消息](mediaId=$movie)视频中的操作步骤', displayText: undefined }), '视频中的操作步骤');
  assert.equal(messageText({ ...message, text: '[图片消息](mediaId=$only)', displayText: '' }), '');
  assert.equal(messageText({ ...message, text: '正常文字 (mediaId=业务参数)', displayText: undefined }), '正常文字 (mediaId=业务参数)');
});
test('topic headings follow archive title and question priority instead of inventing image-topic titles', () => {
  assert.equal(topicTitle({ title: '登录页的俄语翻译缺失', question: '其他问题' }), '登录页的俄语翻译缺失');
  assert.equal(topicTitle({ title: '[图片消息](mediaId=$truncated', question: '登录页的俄语翻译缺失' }), '登录页的俄语翻译缺失');
  assert.equal(topicTitle({ title: '[图片消息](mediaId=$id)登录页的俄语翻译缺失' }), '登录页的俄语翻译缺失');
  assert.equal(topicTitle({ title: '群反馈', issueSummary: '房间名称异常' }), '房间名称异常');
});
test('selecting an original message includes its ready images, which remain independently removable', () => {
  const topic = archiveFixture().topics[0], message = topic.messages[0];
  let basket = changeMessage({}, topic, message);
  assert.deepEqual(basketCounts(basket), { topics: 1, messages: 1, assets: 1 });
  assert.equal(basketSelections(basket)[0].assets[0].messageId, message.id);
  basket = changeAsset(basket, topic, message, message.assets[0]);
  assert.deepEqual(basketCounts(basket), { topics: 1, messages: 1, assets: 0 });
  const pending = archiveFixture().topics[1];
  assert.equal(basketCounts(changeMessage({}, pending, pending.messages[0])).assets, 0);
});
test('timestamps distinguish today, earlier dates and previous years in the viewer timezone', () => {
  const now = new Date(2026, 10, 22, 12, 0).getTime();
  assert.equal(topicTime(new Date(2026, 10, 22, 4, 17).getTime(), now), '04:17');
  assert.equal(topicTime(new Date(2026, 10, 19, 16, 20).getTime(), now), '11-19 16:20');
  assert.equal(topicTime(new Date(2025, 0, 2, 9, 3).getTime(), now), '2025-01-02 09:03');
  assert.equal(topicTime(NaN, now), '');
});


test('a complete video transport envelope is projected as media without swallowing ordinary captions or URLs',()=>{
  const asset={id:'clip',name:'attachment',mimeType:'video',state:'pending'};
  const text='fileName=mmexport1794999988991.mp4\nurl: @opaque-video-id';
  const message={text,assets:[asset]};
  assert.equal(messageText(message),'');assert.equal(message.text,text);
  assert.equal(messageText({...message,text:'[视频消息](mediaId=@native) '+text.replace('\n',' ')}),'');
  assert.equal(messageText({text,assets:[]}),text);
  const caption='附件示例：'+text+'\n按钮出现镜像';
  assert.equal(messageText({...message,text:caption}),caption);
  assert.equal(messageText({...message,text:'参考视频 https://example.test/video.mp4'}),'参考视频 https://example.test/video.mp4');
});


test('native media metadata and its download boilerplate are hidden while surrounding captions survive',()=>{
  const assets=[{id:'clip',name:'视频.mp4',mimeType:'video/mp4',state:'ready'}];
  const envelope='[视频消息](mediaId=@same) fileName=clip.mp4 url: @same 注意: 如需下载 使用 dws chat message download-media 命令下载。';
  assert.equal(messageText({text:envelope,assets}),'');
  assert.equal(messageText({text:'先看这个问题 '+envelope+' 然后比较字幕。',assets}),'先看这个问题  然后比较字幕。');
  const mismatched='[视频消息](mediaId=@one) fileName=clip.mp4 url: @two 这是正文';
  assert.ok(messageText({text:mismatched,assets}).includes('这是正文'));
});
