import { isAbsolute, relative } from 'node:path';
import type { CacheUsage } from '../../shared/cache-management.ts';

/** Only multiply linked files need a persistent inode index. Ordinary files stay
 * in a byte subtotal; overlapping roots are measured in the same atomic cohort. */
export type AccountedUsage = CacheUsage & { accounting?: { unlinkedBytes: number; links: Record<string, number> } };
export type MeasureTarget = { key: string; paths: string[]; exclude?: string[]; usage: CacheUsage; interval: number };
export function containsPath(parent: string, child: string) {
  const part = relative(parent, child);
  return !part || part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part);
}
export function targetsOverlap(a: Pick<MeasureTarget, 'paths' | 'exclude'>, b: Pick<MeasureTarget, 'paths' | 'exclude'>) {
  const contains = (parent: typeof a, child: typeof b) => parent.paths.some(root => child.paths.some(path => containsPath(root, path) && !parent.exclude?.some(exclude => containsPath(exclude, path))));
  return contains(a,b) || contains(b,a);
}
export function measurementCohorts(targets: MeasureTarget[]) {
  const cohorts: MeasureTarget[][] = [];
  for (const target of targets) {
    const matches = cohorts.filter(group => group.some(other => targetsOverlap(target, other)));
    if (!matches.length) cohorts.push([target]);
    else { matches[0].push(target); for (const group of matches.slice(1)) { matches[0].push(...group); cohorts.splice(cohorts.indexOf(group), 1); } }
  }
  return cohorts;
}
export function accountUsage<T extends { usage: CacheUsage }>(rows: T[]): T[] {
  const links = new Set<string>();
  return rows.map(row => {
    const usage = row.usage as AccountedUsage, accounting = usage.accounting;
    if (!accounting) return row;
    let uniqueBytes = accounting.unlinkedBytes;
    for (const [inode, bytes] of Object.entries(accounting.links)) if (!links.has(inode)) { links.add(inode); uniqueBytes += bytes; }
    return { ...row, usage: { ...usage, uniqueBytes } };
  });
}
export function publicUsage(usage: CacheUsage): CacheUsage {
  const { accounting, failures, cacheRevision, ...publicValue } = usage as AccountedUsage & { failures?: number; cacheRevision?: number };
  return publicValue;
}
