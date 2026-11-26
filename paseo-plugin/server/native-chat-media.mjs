// Native host compatibility adapter. No prompt, permission or transport changes.
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { captureChatMedia, nativeChatMediaDisplayed, markNativeChatMediaDisplayed, recordNativeChatMediaRuntime } from './backend/chat-media.ts';

const marker = Symbol.for('workspace-workbench.native-chat-media.v1');
const approved = new Map([
  ['0.17.1', '4a0b476db57826e52082731673cd11410fd3fee483eff6978b7ff6d03537c319'],
  ['0.17.3', '2a701fe04a6ff1861fbdac0532f6e0cd40267fe391a8a5bcee14c92da8e4a256'],
]);
const queues = new Map();
export function withoutMediaPreload(options, adapter = import.meta.url) {
  const escaped = adapter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return options.replace(new RegExp('(^|\\s)(?:--import=(?:"' + escaped + '"|' + escaped + ')|--import\\s+(?:"' + escaped + '"|' + escaped + ')|"--import=' + escaped + '")(?=\\s|$)', 'g'), '$1').trim();
}
// The supervisor retains its startup option for replacement workers. The native
// worker drops only this option before loading application code, so projects,
// providers and terminals never inherit a host-specific Node preload.
if (/[\\/]dist[\\/]server[\\/]server[\\/]daemon-worker\.js$/.test(process.argv[1] || '') && process.env.NODE_OPTIONS) {
  const remaining = withoutMediaPreload(process.env.NODE_OPTIONS);
  if (remaining) process.env.NODE_OPTIONS = remaining; else delete process.env.NODE_OPTIONS;
}
export function attachChatMediaRecorder(Manager, reviewedHost) {
  if (Manager.prototype[marker]) return;
  const original = Manager.prototype.recordSubmittedPrompt;
  if (typeof original !== 'function' || typeof Manager.prototype.appendTimelineItem !== 'function' || typeof Manager.prototype.fetchTimeline !== 'function') throw Error('chat_media_host_unsupported');
  Object.defineProperty(Manager.prototype, marker, { value: true });
  if (reviewedHost) void recordNativeChatMediaRuntime(reviewedHost.version, reviewedHost.sourceHash).catch(() => console.warn('workbench_chat_media_runtime_unavailable'));
  Manager.prototype.recordSubmittedPrompt = function (agent, prompt, messageId, outcome, options) {
    const result = original.call(this, agent, prompt, messageId, outcome, options);
    if (outcome !== 'accepted' || !messageId || !Array.isArray(prompt) || !prompt.some(item => item.type === 'image' || item.type === 'uploaded_file')) return result;
    const key = agent.id + ':' + messageId;
    if (queues.has(key)) return result;
    if (queues.size >= 8) { console.warn('workbench_chat_media_busy'); return result; }
    const flight = (async () => {
      const receipt = await captureChatMedia(agent.id, messageId, prompt);
      if (!receipt || await nativeChatMediaDisplayed(receipt.id)) return;
      const id = 'chat-media:' + receipt.id;
      const { rows } = this.fetchTimeline(agent.id, { direction: 'tail', limit: 100, wholeTurns: false });
      if (!rows.some(row => row.item.type === 'plugin' && row.item.id === id)) await this.appendTimelineItem(agent.id, {
        type: 'plugin', id, pluginId: 'workspace-workbench-paseo', kind: 'workbench-chat-media', version: 1,
        data: { receiptId: receipt.id, messageId },
      });
      await markNativeChatMediaDisplayed(receipt.id);
    })().catch(() => { console.warn('workbench_chat_media_record_failed'); }).finally(() => { if (queues.get(key) === flight) queues.delete(key); });
    queues.set(key, flight);
    return result;
  };
}

registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.startsWith('file:') || !url.endsWith('/dist/server/server/agent/agent-manager.js')) return result;
  const packagePath = new URL('../../../../package.json', url);
  let version;
  try { version = JSON.parse(readFileSync(packagePath, 'utf8')).version; } catch { return result; }
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source || '').toString();
  if (approved.get(version) !== createHash('sha256').update(source).digest('hex')) {
    console.warn('workbench_chat_media_host_not_reviewed'); return result;
  }
  const adapter = new URL('./native-chat-media.mjs', import.meta.url).href;
  return { ...result, source: source + '\nimport {attachChatMediaRecorder as __wbChatMedia} from ' + JSON.stringify(adapter) + ';\n__wbChatMedia(AgentManager, ' + JSON.stringify({version,sourceHash:approved.get(version)}) + ');\n' };
} });
