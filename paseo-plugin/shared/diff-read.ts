/** Internal UI protocol. Agent-facing tools continue to use repository.diff. */
export const DIFF_READ_PROTOCOL = 1;
export const DIFF_READ_BUILD = 'diff-read-v1';
export type DiffReadState = 'queued' | 'running' | 'ready' | 'failed' | 'cancelled';
export type DiffReadStatus = {
  protocol: number; generation: string; requestId: string; taskId: string;
  state: DiffReadState; phase: string; acceptedAt: number; deadline: number;
  queueMs: number; result?: unknown; error?: { code: string; message: string; details?: unknown };
};
