import * as files from 'node:fs';
import * as storage from './storage.ts';
import { Git } from './git.ts';
/** Infrastructure is injected once; mutation and observation owners retain separate lifecycles. */
export const workspaceInfrastructure = { files, storage, Git, clock: { millis: () => Date.now() } };
export type WorkspaceInfrastructure = typeof workspaceInfrastructure;
