import type { ExtensionManifest } from '../../extensions.ts';
export const communicationsManifest: ExtensionManifest = {
  id: 'project-communications', version: '0.1.0', apiVersion: 1,
  name: '项目沟通与需求', description: '从已绑定项目群整理需求、变更与反馈',
  contributions: { tab: '需求与反馈', settings: true, unread: true },
  capabilities: ['project-data', 'background', 'materials', 'session-delivery'],
};
