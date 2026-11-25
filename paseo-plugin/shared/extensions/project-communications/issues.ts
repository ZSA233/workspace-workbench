import { z } from 'zod';
import { issueAssets } from './issue-assets.ts';

const archiveId = z.string().regex(/^[0-9a-f]{64}$/);
const version = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const projectId = z.string().min(1).max(256);
const timestamp = z.number().int().nonnegative();
const materialRef = z.object({ id: archiveId, version });

export const issueSummarySchema = z.object({
  id: archiveId, projectId, number: z.string().min(1).max(256), title: z.string().min(1).max(4096), version,
  updatedAt: timestamp, status: z.string().optional(), priority: z.string().optional(), assignee: z.string().optional(), inTodo: z.boolean(),
});
export const issueAttachmentSchema = materialRef.extend({
  name: z.string().min(1).max(512), state: z.string(), mimeType: z.string().optional(), size: timestamp.optional(),
});
export const issueInlineImageSchema = z.object({
  id: archiveId, name: z.string().min(1).max(512), state: z.string(), offset: timestamp, commentId: archiveId.optional(),
});
export const issueDetailSchema = issueSummarySchema.extend({
  sourceUrl: z.string().max(2048).optional(), body: z.string().max(2 * 1024 * 1024), bodyState: z.string(),
  comments: z.array(materialRef.extend({ text: z.string().max(512 * 1024), author: z.string().optional(), createdAt: timestamp.optional() })).max(300),
  commentsState: z.string(), attachments: z.array(issueAttachmentSchema).max(300), attachmentsState: z.string(),
  inlineImages: z.array(issueInlineImageSchema).max(128).optional(),
});
export const issuePageSchema = z.object({ items: z.array(issueSummarySchema).max(100), next: z.string().min(1).max(2048).optional() });
export const issueSourceSchema = z.object({
  enabled: z.boolean(), authorization: z.string(), plugin: z.string(), account: z.string().optional(),
  projects: z.array(z.object({ id: projectId, label: z.string(), authorization: z.string(), sync: z.string(), lastSuccessAt: timestamp.optional(), error: z.string().optional() })),
});

export type IssueSummary = z.infer<typeof issueSummarySchema>;
export type IssueDetail = z.infer<typeof issueDetailSchema>;
export type IssueAttachment = z.infer<typeof issueAttachmentSchema>;
export type IssueInlineImage = z.infer<typeof issueInlineImageSchema>;
export type IssuePage = z.infer<typeof issuePageSchema>;
export type IssueSource = z.infer<typeof issueSourceSchema>;
export type IssueConnection = { manageUrl?: string } & (
  { state: 'ready'; source: IssueSource } | { state: 'missing' | 'unavailable' }
);

export const issueSelectionSchema = z.object({
  issueId: archiveId, version, body: z.boolean(), comments: z.array(materialRef).max(100), attachments: z.array(materialRef).max(20),
});
export type IssueSelection = z.infer<typeof issueSelectionSchema>;
export type IssueVersion = Pick<IssueSelection, 'issueId' | 'version'>;
export type SelectedIssue = { issue: IssueDetail; selection: IssueSelection };

export const issueStatusAction = z.object({ action: z.literal('issues.status') });
export const issueListAction = z.object({ action: z.literal('issues.list'), query: z.string().max(256),
  projectId: projectId.optional(), cursor: z.string().min(1).max(2048).optional() });
export const issueReadAction = z.object({ action: z.literal('issues.read'), issueId: archiveId, version });
export const issueAssetAction = issueReadAction.extend({ action: z.literal('issues.asset'), attachmentId: archiveId, part: z.enum(['original', 'video-preview']).optional() });

export function tapdSourceUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.origin === 'https://www.tapd.cn' && !url.username && !url.password && !url.hash) return url.href;
  } catch { return undefined; }
}

export function issueMaterialText({ issue, selection }: SelectedIssue): string {
  const source = tapdSourceUrl(issue.sourceUrl);
  const comments = issue.comments.filter(comment => selection.comments.some(ref => ref.id === comment.id && ref.version === comment.version));
  const attachments = issueAssets(issue).filter(asset => selection.attachments.some(ref => ref.id === asset.id && ref.version === asset.version));
  return [
    [`TAPD ${issue.number} · ${issue.title}`, source].filter(Boolean).join('\n'),
    selection.body ? issue.body : '',
    ...comments.map(comment => [comment.author ? `评论 · ${comment.author}` : '评论', comment.text].join('\n')),
    attachments.length ? ['附件', ...attachments.map(asset => asset.name)].join('\n') : '',
  ].filter(Boolean).join('\n\n');
}
