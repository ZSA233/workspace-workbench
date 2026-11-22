import type { ExtensionManifest } from '../../extensions.ts';
export const communicationsManifest: ExtensionManifest = {
  id: 'project-communications', version: '0.2.0', apiVersion: 1,
  name: '档案话题', description: '选择话题原文与附件，带入开发会话',
  contributions: { tab: '话题', settings: true, unread: false },
  capabilities: ['project-data', 'materials', 'session-delivery'],
};
