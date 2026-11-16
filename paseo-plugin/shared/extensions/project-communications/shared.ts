import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { communicationsActionSchema } from './service-contract';
export * from './service-contract';

export const communicationsRpc = defineRpc({ name: 'workspace.workbench.communications',
  input: z.object({ projectConfig: z.string().min(1), extensionId: z.literal('project-communications'), request: communicationsActionSchema }),
  output: z.unknown(),
});
export const communicationsDeliveryRpc = defineRpc({ name:'workspace.workbench.communications-delivery',input:communicationsRpc.input,output:communicationsRpc.output });
