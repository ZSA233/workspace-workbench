export type DiagnosticEvent = Record<string, unknown>;
export type DiagnosticSink = {
  file: string;
  record(event: DiagnosticEvent, extra?: DiagnosticEvent): void;
  status(): { file: string; dropped: number };
  close(): Promise<void>;
};
export function createDiagnosticSink(options: { root: string; component: string; pid?: number; generation?: string }): DiagnosticSink;
export function readDiagnosticEvents(root: string, limit?: number): Promise<DiagnosticEvent[]>;
export const MAX_EVENTS: number;
export const MAX_BYTES: number;
