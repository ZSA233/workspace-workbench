import { DIFF_READ_BUILD } from '../shared/diff-read.ts';

// The host may reload a plugin inside the same process. PID alone is not a
// generation identity; keep this value scoped to the loaded server bundle.
export const readerGeneration = `${DIFF_READ_BUILD}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
