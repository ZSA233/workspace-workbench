import { z } from 'zod';

export const fileBrowserRequests = [
  z.object({ action: z.literal('browser-settings') }),
  z.object({ action: z.literal('browser-configure'), revision: z.string().max(128), mainDirectory: z.string().trim().min(1).max(32768).nullable() }),
  z.object({ action: z.literal('browse-directories'), directory: z.string().trim().min(1).max(32768), cursor: z.string().max(2048).optional() }),
] as const;

export type FileBrowserSettings = { revision: string; mainDirectory: string | null; automaticDirectory: string; effectiveDirectory: string };
export type DirectoryChoices = { directory: string; parent: string | null; entries: { name: string; directory: string }[]; cursor?: string };
