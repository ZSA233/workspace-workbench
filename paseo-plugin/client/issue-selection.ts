import { supportedArtifact } from '../shared/artifact-limits.ts';
import type { IssueAttachment, IssueDetail, IssueSelection, SelectedIssue } from '../shared/extensions/project-communications/issues';

export type IssueBasket = Record<string, SelectedIssue>;
export type IssuePart = { kind: 'body' } | { kind: 'comments' | 'attachments'; id: string; version: string };

export function issueAttachmentSelectable(issue: IssueDetail, attachment: IssueAttachment) {
  return issue.attachmentsState === 'ready' && attachment.state === 'ready' && supportedArtifact(attachment.mimeType || '', attachment.size);
}

export function removeIssue(basket: IssueBasket, id: string): IssueBasket {
  const next = { ...basket };
  delete next[id];
  return next;
}

export function selectIssue(basket: IssueBasket, issue: IssueDetail): IssueBasket {
  if (basket[issue.id]) return removeIssue(basket, issue.id);
  return { ...basket, [issue.id]: { issue, selection: {
    issueId: issue.id, version: issue.version, body: issue.bodyState === 'ready' && Boolean(issue.body.trim()), comments: [],
    attachments: issue.attachments.filter(attachment => issueAttachmentSelectable(issue, attachment)).map(({ id, version }) => ({ id, version })),
  } } };
}

export function changeIssuePart(basket: IssueBasket, issue: IssueDetail, part: IssuePart): IssueBasket {
  const previous = basket[issue.id];
  if (previous && previous.issue.version !== issue.version) return basket;
  const selection: IssueSelection = { ...(previous?.selection || { issueId: issue.id, version: issue.version, body: false, comments: [], attachments: [] }) };
  if (part.kind === 'body') {
    if (issue.bodyState !== 'ready' || !issue.body.trim()) return basket;
    selection.body = !selection.body;
  } else {
    const match = issue[part.kind].find(item => item.id === part.id && item.version === part.version);
    if (!match || (part.kind === 'comments' ? issue.commentsState !== 'ready' || !('text' in match && match.text.trim())
      : !('mimeType' in match && issueAttachmentSelectable(issue, match)))) return basket;
    const items = selection[part.kind];
    selection[part.kind] = items.some(item => item.id === part.id) ? items.filter(item => item.id !== part.id) : [...items, { id: part.id, version: part.version }];
  }
  if (!selection.body && !selection.comments.length && !selection.attachments.length) return removeIssue(basket, issue.id);
  return { ...basket, [issue.id]: { issue, selection } };
}
