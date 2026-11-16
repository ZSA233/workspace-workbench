import type { ExtensionManifest } from '../../../shared/extensions.ts';
import type { ReviewArtifactReference } from '../../../shared/review-packet.ts';

/** Only these host capabilities cross the extension boundary; no Git or arbitrary host commands. */
export interface ExtensionHost {
  projectId: string; dataRoot: string;
  registerMaterials(items: Array<{ id: string; title: string; mimeType: string; bytes: Uint8Array }>): Promise<ReviewArtifactReference[]>;
  deliver(input: { workspaceId: string; requestId: string; text: string; attachments: ReviewArtifactReference[] }): Promise<{ delivery: string; messageId?: string; readConfirmed: false }>;
}
export interface ExtensionDefinition { manifest: ExtensionManifest; }
