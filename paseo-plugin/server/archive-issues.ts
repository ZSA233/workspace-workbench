import { MAX_REGISTERED_BYTES, supportedArtifact } from '../shared/artifact-limits.ts';
import { archivePublicUrl, serviceConnectionSchema } from '../shared/extensions.ts';
import {
  issueDetailSchema, issuePageSchema, issueSourceSchema, tapdSourceUrl,
  type IssueAttachment, type IssueConnection, type IssueDetail, type IssueSelection, type IssueVersion,
} from '../shared/extensions/project-communications/issues.ts';
import type { CommunicationsConnection } from './communications-connection.ts';
import { prepareTopicVideo } from './topic-video.ts';

// Communication-Service registers one TAPD issue source in its owning library.
const sourceId = 'tapd:issues';

export class ArchiveIssues {
  readonly connection: CommunicationsConnection;
  constructor(connection: CommunicationsConnection) { this.connection = connection; }

  get libraryId() { return this.connection.config.libraryId || 'default'; }

  private path(suffix: string) {
    return `libraries/${encodeURIComponent(this.libraryId)}/sources/${encodeURIComponent(sourceId)}/${suffix}`;
  }

  async status(): Promise<IssueConnection> {
    const { endpoint, publicUrl } = serviceConnectionSchema.parse(this.connection.config);
    const url = archivePublicUrl(publicUrl ?? endpoint);
    if (url) {
      if (!url.pathname.endsWith('/')) url.pathname += '/';
      url.search = new URLSearchParams({ view: 'plugin', provider: 'tapd', page: 'issues', library: this.libraryId }).toString();
    }
    try {
      const source = issueSourceSchema.parse(await this.connection.archive(this.path('issue-source')));
      url?.searchParams.set('source', sourceId);
      return { state: 'ready', source, manageUrl: url?.href };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'issue_source_missing') return { state: 'missing', manageUrl: url?.href };
      if (['archive_route_missing', 'route_missing', 'service_http_404', 'service_empty_response'].includes(code))
        return { state: 'unavailable', manageUrl: url?.href };
      throw error;
    }
  }

  async list(input: { query: string; projectId?: string; cursor?: string }) {
    const search = input.query.trim();
    if (Buffer.byteLength(search) > 256) throw Error('issue_query_too_long');
    const query = new URLSearchParams({ view: 'todo', limit: '30', query: search });
    if (input.projectId) query.set('projectId', input.projectId);
    if (input.cursor) query.set('cursor', input.cursor);
    const result = issuePageSchema.parse(await this.connection.archive(this.path('issues?' + query)));
    if (result.items.some(issue => !issue.inTodo || input.projectId && issue.projectId !== input.projectId)) throw Error('issue_outside_todo');
    return result;
  }

  async read(issueId: string, version?: string): Promise<IssueDetail> {
    const query = version ? '?' + new URLSearchParams({ version }) : '';
    const issue = issueDetailSchema.parse(await this.connection.archive(this.path(`issues/${encodeURIComponent(issueId)}${query}`)));
    if (issue.id !== issueId || !issue.inTodo) throw Error('issue_outside_todo');
    if (version && issue.version !== version) throw Error('issue_selection_changed');
    return { ...issue, sourceUrl: tapdSourceUrl(issue.sourceUrl) };
  }

  async current(ref: IssueVersion) {
    // Read the head so new revisions and changes to the user's todo are visible.
    const issue = await this.read(ref.issueId);
    if (issue.version !== ref.version) throw Error('issue_selection_changed');
    return issue;
  }

  async selection(selection: IssueSelection) {
    const issue = await this.current(selection);
    if (selection.body && (issue.bodyState !== 'ready' || !issue.body.trim())) throw Error('issue_material_unavailable');
    if (selection.comments.length && (issue.commentsState !== 'ready' || new Set(selection.comments.map(item => item.id)).size !== selection.comments.length
      || selection.comments.some(ref => !issue.comments.some(comment => comment.id === ref.id && comment.version === ref.version && comment.text.trim()))))
      throw Error('issue_material_unavailable');
    if (new Set(selection.attachments.map(item => item.id)).size !== selection.attachments.length) throw Error('issue_material_unavailable');
    const attachments = selection.attachments.map(ref => {
      const item = this.attachment(issue, ref.id);
      if (item.version !== ref.version) throw Error('issue_selection_changed');
      return item;
    });
    return { issue, attachments };
  }

  private attachment(issue: IssueDetail, id: string) {
    const item = issue.attachments.find(attachment => attachment.id === id);
    if (issue.attachmentsState !== 'ready' || !item || item.state !== 'ready') throw Error('issue_material_unavailable');
    if (!supportedArtifact(item.mimeType || '', item.size)) throw Error('artifact_type_not_allowed');
    return item;
  }

  async original(issue: IssueDetail, item: IssueAttachment) {
    const mimeType = item.mimeType!.toLowerCase();
    const image = mimeType.startsWith('image/');
    const path = this.path(`issues/${encodeURIComponent(issue.id)}/versions/${encodeURIComponent(issue.version)}/attachments/${encodeURIComponent(item.id)}`);
    // Preview returns the same raster bytes with a validated type. Other originals use octet-stream.
    const result = await this.connection.bytes('/v2/archive/' + path + (image ? '?view=preview' : ''), 'GET', undefined, MAX_REGISTERED_BYTES);
    if (!result.bytes.length || (item.size !== undefined && result.bytes.length !== item.size) ||
      (result.mimeType !== mimeType && (image || result.mimeType !== 'application/octet-stream'))) throw Error('issue_material_unavailable');
    return { bytes: result.bytes, mimeType };
  }

  async asset(issueId: string, version: string, attachmentId: string, part?: 'original' | 'video-preview') {
    const issue = await this.read(issueId, version);
    const item = this.attachment(issue, attachmentId);
    if (part === 'video-preview' && !item.mimeType?.startsWith('video/')) throw Error('topic_video_not_video');
    const data = await this.original(issue, item);
    return part === 'video-preview' ? prepareTopicVideo(data.bytes, this.connection.signal) : { mimeType: data.mimeType, base64: data.bytes.toString('base64') };
  }
}
