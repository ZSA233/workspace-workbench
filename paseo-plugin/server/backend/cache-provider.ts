import type { CacheLabel, CacheResource, CacheScope, CacheReference } from '../../shared/cache-management.ts';
import type { Config } from './config.ts';
import type { Json } from './storage.ts';

export type CacheDiscoveryContext = {
  config: Config; workspaces: Json[]; signal: AbortSignal;
  reportDiscoveryIssue?: (message: string) => void;
  /** Cleanup providers call these around each native operation in an aggregate. */
  validateCleanup?: () => Promise<void>;
  cleanupProgress?: (completed: number) => Promise<void>;
};
export type DiscoveredCache = {
  kind: string; kindLabel: CacheLabel; scope: CacheScope; displayPath: string; paths: string[];
  references: CacheReference[]; cleanup: CacheResource['cleanup'];
};
export interface CacheProvider {
  readonly id: string;
  readonly label: CacheLabel;
  discover(context: CacheDiscoveryContext): Promise<DiscoveredCache[]>;
  /** A provider must revalidate its resource and use its tool's own cleanup rules. */
  cleanup(resource: CacheResource, context: CacheDiscoveryContext): Promise<void>;
}

export class CacheProviders {
  private values = new Map<string, CacheProvider>();
  constructor(providers: CacheProvider[]) {
    for (const provider of providers) {
      if (!/^[a-z][a-z0-9-]*$/.test(provider.id) || this.values.has(provider.id)) throw new Error('Invalid or duplicate cache provider');
      this.values.set(provider.id, provider);
    }
  }
  all() { return [...this.values.values()]; }
  get(id: string) { const provider = this.values.get(id); if (!provider) throw new Error('Cache provider unavailable'); return provider; }
}
