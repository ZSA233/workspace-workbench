import type { IssueDetail, IssueSelection, SelectedIssue } from '../shared/extensions/project-communications/issues';
import { issueAssets, issueAssetSelectable } from '../shared/extensions/project-communications/issue-assets.ts';
export { issueAssetSelectable as issueAttachmentSelectable } from '../shared/extensions/project-communications/issue-assets.ts';

export type IssueBasket = Record<string, SelectedIssue>;
export type IssuePart = { kind: 'body' } | { kind: 'comments'; id: string; version: string } | { kind: 'attachments'; id: string; version: string };

function textPart(issue: IssueDetail, part: Exclude<IssuePart, { kind: 'attachments' }>) {
  const comment = part.kind === 'comments' ? issue.comments.find(item => item.id === part.id && item.version === part.version) : undefined;
  if (part.kind === 'comments' && !comment) return { text: '', readable: false, assets: [] };
  const text = part.kind === 'body' ? issue.body : comment?.text || '';
  const readable = part.kind === 'body' ? issue.bodyState === 'ready' : Boolean(comment && issue.commentsState === 'ready');
  const images = new Set((issue.inlineImages || []).filter(image => part.kind === 'body' ? !image.commentId : image.commentId === comment?.id).map(image => image.id));
  const assets = issueAssets(issue).filter(asset => images.has(asset.id) && issueAssetSelectable(issue, asset));
  return { text, readable, assets };
}

export function issuePartSelectable(issue: IssueDetail, part: Exclude<IssuePart, { kind: 'attachments' }>) {
  const value = textPart(issue, part);
  return value.readable && Boolean(value.text.trim()) || value.assets.length > 0;
}

export function issuePartSelected(issue: IssueDetail, selection: IssueSelection | undefined, part: Exclude<IssuePart, { kind: 'attachments' }>) {
  if (!selection) return false;
  const value = textPart(issue, part);
  return value.readable && value.text.trim() ? part.kind === 'body' ? selection.body : selection.comments.some(item => item.id === part.id && item.version === part.version)
    : value.assets.length > 0 && value.assets.every(asset => selection.attachments.some(item => item.id === asset.id && item.version === asset.version));
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
    attachments: issueAssets(issue).filter(attachment => issueAssetSelectable(issue, attachment)).map(({ id, version }) => ({ id, version })),
  } } };
}

export function changeIssuePart(basket: IssueBasket, issue: IssueDetail, part: IssuePart): IssueBasket {
  const previous = basket[issue.id];
  if (previous && previous.issue.version !== issue.version) return basket;
  const selection: IssueSelection = { ...(previous?.selection || { issueId: issue.id, version: issue.version, body: false, comments: [], attachments: [] }) };
  if (part.kind === 'attachments') {
    const match = issueAssets(issue).find(item => item.id === part.id && item.version === part.version);
    if (!match || !issueAssetSelectable(issue, match)) return basket;
    const items = selection.attachments;
    selection.attachments = items.some(item => item.id === part.id) ? items.filter(item => item.id !== part.id) : [...items, { id: part.id, version: part.version }];
  } else {
    if (!issuePartSelectable(issue, part)) return basket;
    const value = textPart(issue, part), selected = issuePartSelected(issue, selection, part), hasText = value.readable && Boolean(value.text.trim());
    if (hasText) {
      if (part.kind === 'body') selection.body = !selected;
      else selection.comments = selected ? selection.comments.filter(item => item.id !== part.id) : [...selection.comments, { id: part.id, version: part.version }];
    }
    if (!selected) selection.attachments = [...new Map([...selection.attachments, ...value.assets.map(({ id, version }) => ({ id, version }))].map(item => [item.id, item])).values()];
    else if (!hasText) selection.attachments = selection.attachments.filter(item => !value.assets.some(asset => asset.id === item.id));
  }
  if (!selection.body && !selection.comments.length && !selection.attachments.length) return removeIssue(basket, issue.id);
  return { ...basket, [issue.id]: { issue, selection } };
}
