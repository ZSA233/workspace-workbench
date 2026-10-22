import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { fileRequest } from './files';

export const filesRpc = defineRpc({
  name: 'workspace.workbench.files',
  input: z.object({ projectConfig: z.string(), request: fileRequest }),
  output: z.object({ ok: z.boolean(), result: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).optional() }),
});
