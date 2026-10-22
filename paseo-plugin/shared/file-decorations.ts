/** Git information is independent of the filesystem listing and its version. */
export type GitMark = '!' | 'D' | 'R' | 'C' | 'T' | 'M' | 'A' | 'U';
export type GitCounts = { total: number; conflicts: number; deleted: number; renamed: number; copied: number; typeChanged: number; modified: number; added: number; untracked: number };
export type FileDecoration = {
  path: string;
  state: 'ready' | 'unknown';
  repository?: string;
  mark?: GitMark;
  /** Multiple porcelain records can describe the same on-disk path. */
  changes?: { index: string; worktree: string; from?: string }[];
  directory?: GitCounts;
  ignored?: { source: string; line: number; pattern: string };
};
export type FileDecorations = {
  workspaceId: string;
  instance: string;
  version: string;
  observedAt: string;
  freshness: 'fresh' | 'refreshing' | 'stale' | 'unknown';
  entries: FileDecoration[];
  issues: { code: string; message: string; path?: string }[];
};
export const emptyGitCounts = (): GitCounts => ({ total: 0, conflicts: 0, deleted: 0, renamed: 0, copied: 0, typeChanged: 0, modified: 0, added: 0, untracked: 0 });
export function gitMark(code: string): GitMark | undefined {
  if (code === '??') return 'U';
  if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code) || code.includes('U')) return '!';
  return (['D', 'R', 'C', 'T', 'M', 'A'] as const).find(mark => code.includes(mark));
}
export const gitCountKey: Record<GitMark, Exclude<keyof GitCounts, 'total'>> = { '!': 'conflicts', D: 'deleted', R: 'renamed', C: 'copied', T: 'typeChanged', M: 'modified', A: 'added', U: 'untracked' };
export function directoryGitMark(counts: GitCounts): GitMark | undefined {
  if (counts.conflicts) return '!';
  if (counts.deleted + counts.renamed + counts.copied + counts.typeChanged + counts.modified) return 'M';
  if (counts.added + counts.untracked) return 'A';
}
