import type { OrganizerEvidence, ConversationAnalysis } from '../../shared/organizer.ts';

type TimelinePage = { epoch: string; hasOlder: boolean; hasNewer: boolean; entries: Array<{ seqStart: number; seqEnd: number; item: unknown }> };
/** Public text only. Chunk cursors never acknowledge an unprocessed suffix of a long message. */
export function conversationBatch(agentId: string, page: TimelinePage, previous?: ConversationAnalysis,chunkSize=1600) {
  const evidence: OrganizerEvidence[] = [];
  const checkpoints = new Map<string, { cursor: { epoch: string; seq: number }; pendingMessage?: { seq: number; offset: number } }>();
  let limited = false;
  for (const entry of page.entries) {
    const item = entry.item as { type?: string; text?: string };
    if (!['user_message', 'assistant_message'].includes(item.type || '') || !item.text) continue;
    const start = previous?.pendingMessage?.seq === entry.seqStart ? previous.pendingMessage.offset : 0;
    for (let offset = start; offset < item.text.length; offset += chunkSize) {
      if (evidence.length >= 80) { limited = true; break; }
      const end = Math.min(offset + chunkSize, item.text.length), id = `message:${agentId}:${page.epoch}:${entry.seqStart}:${offset}`;
      evidence.push({ id, kind: 'message', text: `${item.type}: ${item.text.slice(offset, end)}` });
      checkpoints.set(id, end < item.text.length
        ? { cursor: { epoch: page.epoch, seq: entry.seqStart - 1 }, pendingMessage: { seq: entry.seqStart, offset: end } }
        : { cursor: { epoch: page.epoch, seq: entry.seqEnd } });
    }
    if (limited) break;
  }
  return { evidence, checkpoints, limited, startedAtBeginning: previous?.startedAtBeginning ?? !page.hasOlder };
}
