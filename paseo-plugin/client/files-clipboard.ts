export type FileClipboard = { operation: 'copy' | 'move'; scope: string; entries: { workspaceId: string; instance: string; path: string; version: string }[] };
let value: FileClipboard | undefined;
const listeners = new Set<() => void>();
export const getFileClipboard = () => value;
export function setFileClipboard(next: FileClipboard | undefined) { value = next; listeners.forEach(listener => listener()); }
export function subscribeFileClipboard(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
