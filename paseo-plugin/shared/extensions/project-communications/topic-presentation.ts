import type { ArchiveMessage, ArchiveTopic } from './topics.ts';

const mediaMarker = /\[(?:图片|视频|媒体|文件|附件)消息\]\s*\(\s*(?:mediaId|fileId|assetId)\s*=[^\r\n)]*\)/g;
const mediaLine = /^[ \t]*\[(?:图片|视频|媒体|文件|附件)(?:消息)?\][ \t]*$/gm;
const genericTitles = new Set(['群反馈', '反馈排查', '新话题', '单聊问题', '问题排查', '附件反馈']);

/** A display projection only: source text and its version remain untouched. */
export function messageText(message: Pick<ArchiveMessage, 'text' | 'displayText'> & Partial<Pick<ArchiveMessage, 'assets'>>) {
  const text = typeof message.displayText === 'string' ? message.displayText : message.text || '';
  if (!message.assets?.length) return text;
  return text.replace(mediaMarker, '').replace(mediaLine, '').replace(/\n{3,}/g, '\n\n').trim();
}

function titleText(value: string | undefined) {
  return (value || '').replace(mediaMarker, '')
    // Archive headings can end halfway through a native media identifier.
    .replace(/\[(?:图片|视频|媒体|文件|附件)消息\]\s*(?:\(\s*mediaId=[\s\S]*|$)/g, '')
    .replace(mediaLine, '').replace(/\[消息:[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
}

/** Match the archive workbench's title / issue / question / preview priority. */
export function topicTitle(topic: Pick<ArchiveTopic, 'title'> & Partial<Pick<ArchiveTopic, 'issueSummary' | 'question' | 'preview'>>) {
  const choices = [topic.title, topic.issueSummary, topic.question, topic.preview].map(titleText).filter(Boolean);
  const attachment = [topic.title, topic.question, topic.preview].some(value => /\[(?:图片|视频|媒体|文件|附件)/.test(value || ''));
  return Array.from(choices.find(value => !genericTitles.has(value)) || choices[0] || (attachment ? '附件反馈' : '待补充问题')).slice(0, 160).join('');
}

export function topicTime(value: number, now = Date.now()) {
  const date = new Date(value), current = new Date(now);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  const clock = pad(date.getHours()) + ':' + pad(date.getMinutes());
  const day = [date.getFullYear(), date.getMonth(), date.getDate()];
  if (day[0] === current.getFullYear() && day[1] === current.getMonth() && day[2] === current.getDate()) return clock;
  return (day[0] === current.getFullYear() ? '' : day[0] + '-') + pad(day[1] + 1) + '-' + pad(day[2]) + ' ' + clock;
}
