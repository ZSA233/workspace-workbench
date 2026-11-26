import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { captureChatMedia, chatMediaDownloadPath, chatMediaReceiptId, chatMediaRoot, describeChatMediaFile, readChatMediaFileChunk, readChatMediaImage, readChatMediaReceipt, reserveTopicChatMedia, type PromptMedia } from '../server/backend/chat-media.ts';
import { CHAT_MEDIA_CHUNK_BYTES } from '../shared/chat-media-limits.ts';
import { fixturePng } from './helpers/raster.ts';

const originals = [fixturePng(220, 80, 80), fixturePng(80, 180, 120), fixturePng(80, 120, 220)];
const prompt: PromptMedia[] = [{ type: 'text', data: 'Original task' }, ...originals.map(bytes => ({ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }))];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'wb-chat-media-')), previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
  return { root, close() { if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous; rmSync(root, { recursive: true, force: true }); } };
}
test('native originals survive a cold read, retain order and cannot be read by another session or selection', async () => {
  const s = setup();
  try {
    const receipt = (await captureChatMedia('agent-a', 'message-a', prompt))!;
    assert.equal(receipt.images.length, 3);
    const cold = await readChatMediaReceipt('agent-a', 'message-a', receipt.id);
    for (const [index, image] of cold.images.entries()) assert.deepEqual(Buffer.from((await readChatMediaImage(cold, image.assetId)).base64, 'base64'), originals[index]);
    assert.deepEqual(await captureChatMedia('agent-a', 'message-a', prompt), receipt);
    await assert.rejects(readChatMediaReceipt('another-agent', 'message-a', receipt.id), /outside_session/);
    await assert.rejects(readChatMediaImage(cold, 'a'.repeat(64)), /outside_selection/);
    await assert.rejects(captureChatMedia('agent-a', 'message-a', prompt.slice(0, 2)), /receipt_changed/);
    assert.deepEqual(await readChatMediaReceipt('agent-a', 'message-a', receipt.id), receipt);
    writeFileSync(join(chatMediaRoot(), 'images', cold.images[0].assetId), 'corrupted');
    await assert.rejects(readChatMediaImage(cold, cold.images[0].assetId), /image_changed/);
  } finally { s.close(); }
});
test('native file history retains only its completed upload and rejects changed or arbitrary paths', async () => {
  const s = setup();
  try {
    const id = 'upload_' + randomUUID(), directory = join(s.root, 'uploads', id), path = join(directory, 'report.pdf'), bytes = Buffer.from('%PDF-1.7\nfixture');
    mkdirSync(directory, { recursive: true }); writeFileSync(path, bytes);
    const file = { type: 'uploaded_file', id, fileName: 'report.pdf', mimeType: 'application/pdf', size: bytes.length, path };
    const receipt = (await captureChatMedia('agent-a', 'file-message', [file]))!;
    assert.equal(receipt.files.length, 1);
    assert.equal((await chatMediaDownloadPath(receipt, receipt.files[0].assetId)).path, path);
    const outside = join(s.root, 'not-an-upload.pdf'); writeFileSync(outside, bytes);
    const other = (await captureChatMedia('agent-a', 'outside', [{ ...file, path: outside }]))!;
    assert.equal(other.files[0].uploadId, undefined);
    await assert.rejects(chatMediaDownloadPath(other, other.files[0].assetId), /file_unavailable/);
    writeFileSync(path, 'changed');
    await assert.rejects(chatMediaDownloadPath(receipt, receipt.files[0].assetId), /file_changed/);
    const link = join(directory, 'linked.pdf'); symlinkSync(outside, link);
    const linked = (await captureChatMedia('agent-a', 'symlink', [{ ...file, fileName: 'linked.pdf', path: link }]))!;
    assert.equal(linked.files[0].uploadId, undefined);
  } finally { s.close(); }
});
test('topic reservations prevent a second native media copy and invalid image inputs cannot enter history', async () => {
  const s = setup();
  try {
    await reserveTopicChatMedia('agent-a', 'topic-message');
    await reserveTopicChatMedia('agent-a', 'topic-message');
    assert.equal(await captureChatMedia('agent-a', 'topic-message', prompt), undefined);
    await assert.rejects(captureChatMedia('agent-a', 'invalid', [{ type: 'image', data: 'not base64', mimeType: 'image/png' }]), /invalid_image/);
    await assert.rejects(captureChatMedia('agent-a', 'too-many', Array(21).fill(prompt[1])), /limit/);
    assert.notEqual(chatMediaReceiptId('agent-a', 'message-a'), chatMediaReceiptId('agent-b', 'message-a'));
  } finally { s.close(); }
});
test('file chunks preserve the selected upload version and reject changed files and unaligned ranges', async () => {
  const s=setup();
  try {
    const id='upload_'+randomUUID(),directory=join(s.root,'uploads',id),path=join(directory,'archive.bin');
    const bytes=Buffer.alloc(CHAT_MEDIA_CHUNK_BYTES+17,19);mkdirSync(directory,{recursive:true});writeFileSync(path,bytes);
    const receipt=(await captureChatMedia('agent-a','chunks',[{type:'uploaded_file',id,path,fileName:'archive.bin',size:bytes.length}]))!;
    const selected=await chatMediaDownloadPath(receipt,receipt.files[0].assetId),descriptor=await describeChatMediaFile(selected.path,selected.file.size);
    const first=await readChatMediaFileChunk(descriptor,0,descriptor.revision),last=await readChatMediaFileChunk(descriptor,CHAT_MEDIA_CHUNK_BYTES,descriptor.revision);
    assert.deepEqual(Buffer.concat([Buffer.from(first.base64,'base64'),Buffer.from(last.base64,'base64')]),bytes);
    await assert.rejects(readChatMediaFileChunk(descriptor,1,descriptor.revision),/file_changed/);
    await assert.rejects(readChatMediaFileChunk(descriptor,0,'a'.repeat(64)),/file_changed/);
    writeFileSync(path,Buffer.alloc(bytes.length,20));
    await assert.rejects(readChatMediaFileChunk(descriptor,0,descriptor.revision),/file_changed/);
  } finally {s.close();}
});
test('the native recorder appends after the accepted user message, without mutating or replaying its prompt', async () => {
  const s = setup();
  try {
    const { attachChatMediaRecorder } = await import(new URL('./fixtures/native-chat-media.mjs', import.meta.url).href);
    class Manager {
      rows: Array<{ item: { type: string; id?: string; messageId?: string; data?: unknown } }> = [];
      calls = 0;
      recordSubmittedPrompt(_agent: { id: string }, _prompt: PromptMedia[], messageId: string, _outcome: string) { this.calls++; this.rows.push({ item: { type: 'user_message', messageId } }); }
      fetchTimeline() { return {rows:this.rows}; }
      async appendTimelineItem(_id: string, item: typeof this.rows[number]['item']) { this.rows.push({ item }); }
    }
    attachChatMediaRecorder(Manager); attachChatMediaRecorder(Manager);
    const manager = new Manager(), agent = { id: 'native-agent' }, original = JSON.stringify(prompt);
    manager.recordSubmittedPrompt(agent, prompt, 'native-message', 'accepted');
    for (const deadline = Date.now() + 3000; !manager.rows.some(row => row.item.type === 'plugin');) { assert.ok(Date.now() < deadline); await sleep(10); }
    assert.equal(manager.rows[0].item.type, 'user_message'); assert.equal(manager.rows[1].item.type, 'plugin');
    assert.equal(manager.calls, 1); assert.equal(JSON.stringify(prompt), original);
    manager.recordSubmittedPrompt(agent, prompt, 'native-message', 'accepted');
    await sleep(40);
    assert.equal(manager.rows.filter(row => row.item.type === 'plugin').length, 1);
    const data = manager.rows[1].item.data as { receiptId: string; messageId: string };
    const receipt = await readChatMediaReceipt(agent.id, data.messageId, data.receiptId);
    assert.equal(receipt.images.length, 3);
    assert.equal(JSON.stringify(receipt).includes('Original task'), false);
    assert.equal(readFileSync(join(chatMediaRoot(), 'images', receipt.images[0].assetId)).equals(originals[0]), true);
  } finally { s.close(); }
});
test('native preload stays in the supervisor launch but is removed from provider and project child environments', async () => {
  const s=setup();
  try {
    const adapter=new URL('./fixtures/native-chat-media.mjs',import.meta.url).href;
    const {withoutMediaPreload}=await import(adapter);
    assert.equal(withoutMediaPreload('--no-warnings --import='+adapter+' --stack-trace-limit=50'),'--no-warnings  --stack-trace-limit=50');
    assert.equal(withoutMediaPreload('--import "'+adapter+'"'),'');
    assert.equal(withoutMediaPreload('"--import='+adapter+'"'),'');
    assert.equal(withoutMediaPreload('--import=file:///another-hook.mjs'),'--import=file:///another-hook.mjs');
    const directory=join(s.root,'node_modules/@getpaseo/server/dist/server/server');mkdirSync(directory,{recursive:true});
    const worker=join(directory,'daemon-worker.js');
    writeFileSync(worker,"const {execFileSync}=require('node:child_process');process.stdout.write(execFileSync(process.execPath,['-p','process.env.NODE_OPTIONS'],{encoding:'utf8'}));");
    const result=execFileSync(process.execPath,[worker],{encoding:'utf8',env:{...process.env,NODE_OPTIONS:'--no-warnings --import='+adapter},timeout:10000});
    assert.equal(result.trim(),'--no-warnings');
    assert.equal(process.env.NODE_OPTIONS?.includes(adapter)||false,false);
  }finally{s.close();}
});
