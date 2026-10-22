import type { FileDecoration, GitMark } from '../shared/file-decorations.ts';
import { observerAccent, surfaceLuminance, type ObserverTheme } from './theme.ts';

export function fileGitPalette(theme: ObserverTheme) {
  const dark = (surfaceLuminance(theme.colors.surface0) ?? 0) < 0.35;
  return { added: dark ? '#73c991' : '#237a36', modified: dark ? '#e2b86b' : '#986b00', conflict: dark ? '#f08080' : '#b42318', renamed: observerAccent(theme), ignored: dark ? '#8b8f96' : '#6b7078' };
}
export function fileGitColor(entry: FileDecoration | undefined, palette: ReturnType<typeof fileGitPalette>, foreground: string) {
  if (entry?.mark === '!') return palette.conflict;
  if (entry?.mark === 'U' || entry?.mark === 'A') return palette.added;
  if (entry?.directory && entry.mark || entry?.mark === 'M' || entry?.mark === 'T' || entry?.mark === 'D') return palette.modified;
  if (entry?.mark) return palette.renamed;
  return entry?.ignored ? palette.ignored : foreground;
}
const labels: Record<GitMark, [string, string]> = { '!': ['合并冲突', 'Merge conflict'], D: ['删除', 'Deleted'], R: ['重命名', 'Renamed'], C: ['复制', 'Copied'], T: ['类型变化', 'Type changed'], M: ['修改', 'Modified'], A: ['新增', 'Added'], U: ['未跟踪', 'Untracked'] };
const label = (mark: string, zh: boolean) => labels[mark as GitMark]?.[zh ? 0 : 1] || mark;
export function fileGitDescription(entry: FileDecoration | undefined, zh: boolean, pending = false): string {
  if (!entry || entry.state === 'unknown') return zh ? 'Git 状态未知，等待更新' : 'Git status unknown; awaiting update';
  const lines: string[] = [];
  if (pending) lines.push(zh ? 'Git 状态待更新（保留上次结果）' : 'Git status pending update (previous result retained)');
  if (entry.ignored) {
    lines.push(zh ? 'Git：已忽略，未跟踪内容不会进入提交' : 'Git: ignored; untracked content is excluded from commits');
    lines.push(`${entry.ignored.source}:${entry.ignored.line} · ${entry.ignored.pattern}`);
  } else if (entry.directory) {
    const counts = entry.directory;
    lines.push(zh ? `Git：${counts.total} 项未提交变动（含暂存区）` : `Git: ${counts.total} uncommitted changes (including index)`);
    const keys = { '!': counts.conflicts, D: counts.deleted, R: counts.renamed, C: counts.copied, T: counts.typeChanged, M: counts.modified, A: counts.added, U: counts.untracked };
    lines.push(Object.entries(keys).filter(([, count]) => count).map(([key, count]) => `${label(key, zh)} ${count}`).join(' · '));
  } else if (entry.mark) lines.push(`Git：${label(entry.mark, zh)}`);
  else lines.push(entry.repository === undefined ? zh ? '不在已登记 Git 仓库范围内' : 'Outside registered Git repositories' : zh ? 'Git：无未提交变动' : 'Git: no uncommitted changes');
  for (const change of entry.changes || []) {
    if (change.index === '?' && change.worktree === '?') continue;
    const rawLabel = (code: string) => code === 'U' ? zh ? '未合并' : 'Unmerged' : label(code, zh);
    if (change.index !== ' ' && change.index !== '?') lines.push(`${zh ? '暂存区' : 'Index'}：${rawLabel(change.index)}`);
    if (change.worktree !== ' ' && change.worktree !== '?') lines.push(`${zh ? '工作目录' : 'Working tree'}：${rawLabel(change.worktree)}`);
    if (change.from) lines.push(`${zh ? '原路径' : 'From'}：${change.from}`);
  }
  return lines.filter(Boolean).join('\n');
}
export function fileTreeIcon(name: string, kind: string, expanded = false): string {
  if (kind === 'directory') return expanded ? 'FolderOpen' : 'Folder';
  if (kind === 'link') return 'FileLink';
  const value = name.toLowerCase(), extension = value.split('.').at(-1) || '';
  if (/^(png|jpe?g|gif|webp|svg|ico|avif|bmp|heic)$/.test(extension)) return 'FileImage';
  if (/^(zip|gz|tgz|tar|7z|rar|bz2|xz|zst)$/.test(extension)) return 'FileArchive';
  if (/^(json|jsonc|ya?ml|toml|ini|conf|config|xml|env|lock)$/.test(extension) || /^\.(gitignore|gitattributes|editorconfig|npmrc|env)/.test(value) || /^(dockerfile|makefile)$/.test(value)) return 'FileConfig';
  if (/^(tsx?|jsx?|mjs|cjs|vue|svelte|py|rs|go|java|kt|swift|c|cpp|h|css|scss|html?|sh|sql|rb|php)$/.test(extension)) return 'FileCode';
  if (/^(md|mdx|txt|rst|log|csv)$/.test(extension) || /^readme|^license/.test(value)) return 'FileText';
  return 'File';
}
