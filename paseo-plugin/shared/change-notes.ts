import type {Comparison} from './comparison';
import {z} from 'zod';
export const noteAnchor=z.object({path:z.string().min(1).max(4096),side:z.enum(['file','old','new']),start:z.number().int().positive().optional(),end:z.number().int().positive().optional()}).strict();
export const noteContent=z.object({title:z.string().min(1).max(200),reason:z.string().min(1).max(8000),behavior:z.string().min(1).max(8000),basis:z.enum(['requirement','autonomous','missing-context']),requirement:z.string().max(8000).default(''),perspective:z.enum(['implementer','inferred']),question:z.string().max(4000).default(''),evidence:z.string().max(8000).default(''),anchors:z.array(noteAnchor).min(1).max(32)}).strict();
export const noteBatch=z.object({requestId:z.string().min(1).max(200),snapshotId:z.string().regex(/^[a-f0-9]{64}$/),operations:z.array(z.object({id:z.string().min(1).max(100),expectedRevision:z.number().int().nonnegative(),action:z.enum(['upsert','withdraw']),content:noteContent.optional()}).strict()).min(1).max(32)}).strict();
export const noteFeedback=z.object({requestId:z.string().min(1).max(200),id:z.string().min(1),revision:z.number().int().positive(),action:z.enum(['read','question','confirm']),text:z.string().max(4000).default('')}).strict();
export const noteTextEdit=noteContent.omit({anchors:true});
// UI-only management; deliberately absent from the Agent tool schema.
export const noteManagement=z.discriminatedUnion('action',[
 z.object({requestId:z.string().min(1).max(200),id:z.string().min(1).max(100),revision:z.number().int().positive(),action:z.literal('edit'),content:noteTextEdit}).strict(),
 z.object({requestId:z.string().min(1).max(200),id:z.string().min(1).max(100),revision:z.number().int().positive(),action:z.literal('withdraw')}).strict(),
 z.object({requestId:z.string().min(1).max(200),id:z.string().min(1).max(100),revision:z.number().int().positive(),action:z.enum(['question-edit','question-delete']),eventId:z.string().min(1).max(200),expectedVersion:z.number().int().positive(),text:z.string().max(4000).default('')}).strict()
]);
export type NoteManagement=z.infer<typeof noteManagement>;
export type NoteManagementInput=NoteManagement extends infer T ? T extends NoteManagement ? Omit<T,'requestId'|'id'|'revision'> : never : never;
export type NoteTextEdit=z.infer<typeof noteTextEdit>;
export type NoteContent=z.infer<typeof noteContent>;
export type NoteAnchor=z.infer<typeof noteAnchor>;
export type ChangeNote={historical?:boolean;latestRevision?:number;id:string;revision:number;snapshotId:string;author:string;editedBy?:'user';updatedAt:string;withdrawn:boolean;content:NoteContent};
export type NoteUserEvent={eventId?:string;version?:number;deleted?:boolean;updatedAt?:string;id:string;revision:number;action:'read'|'question'|'confirm';text:string;at:string};
export type NotesResult={nextOffset?:number|null;revision?:string;workingToken?:string;notes:ChangeNote[];feedback:NoteUserEvent[];snapshots:Record<string,{projectId?:string;workspaceId?:string;repoPath?:string;scope:string;workingToken?:string;comparison?:unknown;left:string|null;right:string|null;files:Array<{path:string;oldPath?:string|null;patch?:string;digest:string;truncated:boolean;binary:boolean}>}>};

export type ComparisonNoteRecord={id:string;comparison:Comparison;aliases:Array<{fromRef:string;toRef:string}>;noteCount:number;pendingCount:number;updatedAt:string};
export type ComparisonNoteCatalog={records:ComparisonNoteRecord[];total:number;matched:number;nextOffset:number|null;revision:string};
