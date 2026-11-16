import type { CacheResource, CacheUsage } from '../../shared/cache-management.ts';

const MINUTE = 60_000, DAY = 24 * 60 * MINUTE;
export const DISCOVERY_INTERVAL = 30 * MINUTE;
export const VIEW_LEASE = 45_000;
export type CacheActivity = { usedAt?: number; changedAt?: number };
export type ScheduledUsage = CacheUsage & { failures?: number };

export function workspaceScanInterval(activityAt: number | undefined, now: number) {
  if (!activityAt) return DAY;
  const age = Math.max(0, now - activityAt);
  return age < DAY ? 10 * MINUTE : age < 7 * DAY ? 60 * MINUTE : age < 30 * DAY ? DAY : 7 * DAY;
}
export function resourceScanInterval(resource: CacheResource, intervals: Map<string, number>) {
  if (resource.scope === 'global') return 30 * MINUTE;
  const interval = Math.min(...resource.references.map(ref => intervals.get(ref.instance) ?? DAY));
  return resource.scope === 'project' ? Math.max(10 * MINUTE, Math.min(60 * MINUTE, interval)) : Number.isFinite(interval) ? interval : DAY;
}
export function usageDueAt(usage: CacheUsage, interval: number) {
  const value = usage as ScheduledUsage;
  if (value.failures && usage.attemptedAt) return usage.attemptedAt + Math.min(60 * MINUTE, 5 * MINUTE * 2 ** Math.min(value.failures - 1, 4));
  if (usage.invalidatedAt || !usage.observedAt) return 0;
  return usage.observedAt + interval;
}
export function retainCacheUsage(previous: CacheUsage, measured: CacheUsage, at: number): CacheUsage {
  if (measured.state === 'failed' || measured.state === 'partial') {
    const keep = previous.bytes !== null && !!previous.observedAt;
    return { ...(keep ? previous : measured), state: measured.state, error: measured.error, attemptedAt: at,
      failures: ((previous as ScheduledUsage).failures || 0) + 1 } as ScheduledUsage;
  }
  return { ...measured, observedAt: at, attemptedAt: at };
}
