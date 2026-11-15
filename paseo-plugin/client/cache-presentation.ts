import type { CacheResource, CacheUsage } from '../shared/cache-management.ts';
export function cacheBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}
export function cacheUsageText(usage: CacheUsage | undefined, zh: boolean) {
  return usage?.bytes === null || !usage ? zh ? '待统计' : 'Pending' : cacheBytes(usage.bytes);
}
export function cacheRelationship(resources: CacheResource[], zh: boolean) {
  if (!resources.length) return zh ? '缓存待统计' : 'Cache pending';
  if (resources.some(resource => resource.scope === 'project')) return zh ? '项目共享' : 'Project shared';
  if (resources.some(resource => resource.scope === 'global')) return zh ? '全局共享' : 'Globally shared';
  return resources.some(resource => resource.references.length > 1) ? zh ? '共享缓存' : 'Shared cache' : zh ? '独占缓存' : 'Dedicated cache';
}
