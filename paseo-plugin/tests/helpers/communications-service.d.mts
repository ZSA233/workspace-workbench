import type { ChildProcess } from 'node:child_process';
export function serviceBinary(): string;
export function serviceAvailable(): boolean;
export function startService(home: string): Promise<{
  child: ChildProcess;
  url: string;
  token: string;
  request(path: string, method?: string, input?: unknown): Promise<any>;
  close(): Promise<void>;
}>;
export function until(read: () => boolean | Promise<boolean>, timeout?: number): Promise<void>;
