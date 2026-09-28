/** Shared scheduling policy; cache age is not proof of a change. */
export const OBSERVATION_POLICY = {
  pollMs: 15_000,
  leaseMs: 90_000,
  legacyReadMs: 30_000,
  retentionMs: 600_000,
  recoveryMs: [5_000, 15_000, 30_000, 60_000],
  retryMs: [2_000, 5_000, 10_000, 30_000],
  followUpMs: [250, 1_000, 3_000],
  warningMs: 90_000,
} as const;

export const observationQueryOptions = {
  staleTime: Infinity,
  gcTime: OBSERVATION_POLICY.retentionMs,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: false,
} as const;
