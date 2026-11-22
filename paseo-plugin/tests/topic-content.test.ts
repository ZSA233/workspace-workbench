import assert from 'node:assert/strict';
import test from 'node:test';
import type {ArchiveMessage} from '../shared/extensions/project-communications/topics.ts';
import {prepareTopicContent,topicContentPeople,type TopicContentEntry} from '../shared/extensions/project-communications/topic-content.ts';

const first=Date.parse('2026-11-19T08:20:00Z');
function message(id:string,name:string,text:string,time=first,patch:Partial<ArchiveMessage>={}):ArchiveMessage{
  return {id,sender:name,senderId:'person-'+name,text,createdAt:time,version:'v1',sourceId:'chat:private',sourceAccountId:'account',channelId:'private-group',assets:[],...patch};
}
const entry=(value:ArchiveMessage,topicId='one'):TopicContentEntry=>({topicId,message:value});

test('a single speaker keeps ordinary forwarded text without a sender/time wrapper',()=>{
  const result=prepareTopicContent([entry(message('one','张三','按钮没有翻译。'))],{},'请看看这个问题。');
  assert.equal(result.conversation,false);assert.equal(result.text,'请看看这个问题。\n\n按钮没有翻译。');
  assert.equal(result.text.includes('2026'),false);assert.equal(result.text.includes('参与者'),false);
});

test('multiple topics become one chronological conversation with consistent speaker, mention, reply and note identities',()=>{
  const a=message('a','张三','@李四 请确认这一步。'),b=message('b','李四','@张三(张三) 收到，我来处理。',first+60000,{quote:{messageId:'a'}});
  const result=prepareTopicContent([entry(b,'second'),entry(a,'first')],{},'请重点看李四的回应。');
  assert.equal(result.conversation,true);assert.equal(result.rows[0].message.id,'a');assert.equal(result.rows[1].message.id,'b');
  assert.equal(result.rows[0].speaker,'参与者 A');assert.equal(result.rows[0].text,'@参与者 B 请确认这一步。');
  assert.equal(result.rows[1].text,'@参与者 A 收到，我来处理。');assert.equal(result.rows[1].replyTo,'参与者 A');
  assert.ok(result.text.startsWith('请重点看参与者 B的回应。'));
  assert.ok(result.text.includes('2026-11-19 16:20'));assert.ok(result.text.includes('2026-11-19 16:21'));
  for(const value of ['张三','李四','private-group','person-','account'])assert.equal(result.text.includes(value),false,value);
});

test('source identity keeps renamed authors together and distinguishes people sharing a display name',()=>{
  const result=prepareTopicContent([entry(message('a','张三','第一条',first,{senderId:'same'})),entry(message('b','小张','@张三 我补充一下。',first+1000,{senderId:'same'})),
    entry(message('c','李四','@小张 好的。',first+2000))]);
  assert.equal(result.rows[0].speaker,result.rows[1].speaker);assert.equal(result.people.length,2);
  assert.equal(result.rows[2].text,'@参与者 A 好的。');
  const ambiguous=prepareTopicContent([entry(message('a','小张','第一条',first,{senderId:'first'})),entry(message('b','小张','第二条',first+1,{senderId:'second'})),
    entry(message('c','李四','@小张 请确认。',first+2))]);
  assert.equal(ambiguous.people.length,3);assert.ok(ambiguous.rows[2].text.includes('@小张'));assert.ok(ambiguous.unresolved.includes('小张'));
});

test('unknown mentions, code, emails and package paths survive identity processing',()=>{
  const a=message('a','Alice','Alice@example.com https://host.test/Alice @Alice/sdk `@Alice`\n```ts\n@Alice\n```\n@未入选的人 还有问题。');
  const result=prepareTopicContent([entry(a)]);
  for(const value of ['Alice@example.com','https://host.test/Alice','@Alice/sdk','`@Alice`','@未入选的人'])assert.ok(result.text.includes(value),value);
  assert.ok(result.unresolved.includes('未入选的人'));
});

test('unknown dates are explicit; equal timestamps use the archive sequence',()=>{
  const result=prepareTopicContent([entry(message('b','李四','后到',first,{ingestSequence:8})),entry(message('a','张三','先到',first,{ingestSequence:7})),
    entry(message('c','王五','未知时间',0,{timestampKnown:false}))]);
  assert.deepEqual(result.rows.map(row=>row.message.id),['a','b','c']);assert.equal(result.rows[2].time,'时间未提供');assert.equal(result.text.includes('1970'),false);
});

test('adding earlier context never renumbers the existing speakers or edited references',()=>{
  const a=entry(message('a','张三','最初选中的内容',first+60000)),b=entry(message('b','李四','@张三 好的。',first+120000));
  const aliases=topicContentPeople([a,b]).map(({key,label})=>({key,label}));
  const earlier=entry(message('earlier','王五','更早的上下文',first));
  const result=prepareTopicContent([a,b,earlier],{aliases});
  assert.equal(result.rows[0].speaker,'参与者 C');assert.equal(result.rows[1].speaker,'参与者 A');assert.equal(result.rows[2].speaker,'参与者 B');
  assert.equal(result.rows[2].text,'@参与者 A 好的。');
});

test('source versions keep original text separate from editable delivery text and duplicate selections are not repeated',()=>{
  const source=message('a','张三','原始内容');
  const result=prepareTopicContent([{...entry(source,'one'),editedText:'修正后的内容'},entry(source,'two')]);
  assert.equal(source.text,'原始内容');assert.equal(result.text,'修正后的内容');assert.equal(result.rows.length,1);
  assert.throws(()=>prepareTopicContent([{...entry(source),editedText:'一'},{...entry(source,'two'),editedText:'二'}]),/edit_conflict/);
});

test('templates substitute placeholders once without interpreting placeholders inside the users words',()=>{
  const result=prepareTopicContent([entry(message('a','张三','原文中的 {{note}} 不应替换。'))],{template:'要求：{{note}}\n\n资料：{{materials}}'},'我的 {{materials}} 是字面内容。');
  assert.equal(result.text,'要求：我的 {{materials}} 是字面内容。\n\n资料：原文中的 {{note}} 不应替换。');
  assert.throws(()=>prepareTopicContent([],{template:'只剩下 {{note}}'}),/template_invalid/);
});

test('image-only material never pulls in its unselected source text',()=>{
  const image={id:'image',name:'image.png',mimeType:'image/png',state:'ready'};
  const a=message('a','张三','不应发送的文字',first,{assets:[image]}),b=message('b','李四','第二条消息',first+1000);
  const result=prepareTopicContent([{...entry(a),includeText:false,assetIds:['image']},entry(b)]);
  assert.equal(result.text.includes('不应发送'),false);assert.ok(result.text.includes('参与者 A'));assert.ok(result.text.includes('第二条消息'));
});
