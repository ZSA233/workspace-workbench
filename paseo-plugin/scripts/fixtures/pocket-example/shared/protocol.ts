import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const examplePing = defineRpc({ name: 'pocket.example.ping',
  input: z.object({ workspaceId: z.string(), panel: z.number() }),
  output: z.object({ plugin: z.string(), workspaceId: z.string(), panel: z.number() }),
});
