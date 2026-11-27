import { selectableArchiveArtifact } from '../../artifact-limits.ts';
import type { IssueAttachment, IssueDetail, IssueInlineImage } from './issues.ts';

export type IssueAsset = IssueAttachment & { kind?: 'image' };

/** Inline originals use the issue version and the existing versioned attachment endpoint. */
export function issueAssets(issue: IssueDetail): IssueAsset[] {
  const assets = new Map<string, IssueAsset>(issue.attachments.map(asset => [asset.id, asset]));
  const comments = new Set(issue.comments.map(comment => comment.id));
  for (const image of issue.inlineImages || []) {
    if (assets.has(image.id) || image.commentId && !comments.has(image.commentId)) continue;
    assets.set(image.id, { id: image.id, version: issue.version, name: image.name, state: image.state, kind: 'image' });
  }
  return [...assets.values()];
}

export function issueAssetSelectable(issue: IssueDetail, asset: IssueAsset) {
  if (asset.state !== 'ready') return false;
  if (issue.attachments.some(item => item.id === asset.id && item.version === asset.version)) {
    return issue.attachmentsState === 'ready' && selectableArchiveArtifact(asset.mimeType || '', asset.size);
  }
  if (asset.kind !== 'image' || asset.version !== issue.version) return false;
  return Boolean(issue.inlineImages?.some(image => image.id === asset.id && image.state === 'ready' &&
    (image.commentId ? issue.commentsState === 'ready' && issue.comments.some(comment => comment.id === image.commentId)
      : issue.bodyState === 'ready' || issue.bodyState === 'empty')));
}

/** The archive offsets count Unicode code points, including astral characters. */
export function issueTextParts(text: string, images: IssueInlineImage[]) {
  const characters = Array.from(text), groups = new Map<number, IssueInlineImage[]>();
  for (const image of images) {
    const offset = Math.min(image.offset, characters.length);
    groups.set(offset, [...(groups.get(offset) || []), image]);
  }
  const parts: Array<{ text: string; images: IssueInlineImage[] }> = [];
  let start = 0;
  for (const [offset, placements] of [...groups].sort(([left], [right]) => left - right)) {
    parts.push({ text: characters.slice(start, offset).join(''), images: placements });
    start = offset;
  }
  parts.push({ text: characters.slice(start).join(''), images: [] });
  return parts;
}
