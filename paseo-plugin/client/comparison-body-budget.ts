import type { QueryClient } from '@tanstack/react-query';
const lastUse = new WeakMap<QueryClient, Map<string, number>>();
export const COMPARISON_BODY_BUDGET = 8 * 1024 * 1024;
export function trimComparisonBodies(client: QueryClient, protectedKeys: Set<string>) {
    const ages = lastUse.get(client);
    let total = 0;
    const candidates = client.getQueryCache().getAll().filter(q => q.meta?.comparisonBody && !q.isActive() && !protectedKeys.has(JSON.stringify(q.queryKey))).map(q => { const bytes = q.state.data ? JSON.stringify(q.state.data).length * 2 : 0; total += bytes; return { q, bytes, time: ages?.get(q.queryHash) || q.state.dataUpdatedAt }; }).sort((a, b) => a.time - b.time);
    for (const item of candidates) {
        if (total <= COMPARISON_BODY_BUDGET)
            break;
        client.removeQueries({ queryKey: item.q.queryKey, exact: true });
        ages?.delete(item.q.queryHash);
        total -= item.bytes;
    }
}
export function markComparisonBodyUsed(client: QueryClient, hash: string) { let ages = lastUse.get(client); if (!ages) {
    ages = new Map();
    lastUse.set(client, ages);
} ages.set(hash, Date.now()); }
