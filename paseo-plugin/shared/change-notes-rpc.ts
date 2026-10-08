import {defineRpc} from '@getpaseo/plugin';
import {z} from 'zod';
import {noteBatch,noteFeedback,noteManagement} from './change-notes';
import {observerResponse} from './observer';
export const changeNotesRpc=defineRpc({name:'workspace.workbench.change-notes',input:z.object({projectConfig:z.string().min(1),workspaceId:z.string().min(1),repoPath:z.string().min(1),token:z.string().optional(),action:z.enum(['read','list','write','feedback','manage']),list:z.boolean().optional(),scope:z.enum(['branch','working','commit','compare']).optional(),comparison:z.record(z.string(),z.unknown()).optional(),commitSha:z.string().optional(),paths:z.array(z.string()).max(8).optional(),offset:z.number().int().nonnegative().optional(),snapshotId:z.string().optional(),batch:noteBatch.optional(),feedback:noteFeedback.optional(),management:noteManagement.optional()}).strict(),output:observerResponse});
