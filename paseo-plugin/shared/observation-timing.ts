import { z } from "zod";

/**
 * Observation timing is deliberately separate from mutation, reviewer and
 * worker-lifecycle timing.  Those operations have different semantics and
 * must not accidentally inherit a read-only observation deadline.
 */
export const OBSERVATION_TIMING_DEFAULTS = {
  gitTimeoutSeconds: 3,
  observationGraceSeconds: 5,
  cacheTtlSeconds: 3,
  observationTimeoutMaxSeconds: 600,
  refreshIntervalsMs: {
    list: 30_000,
    detail: 30_000,
    repository: 45_000,
    review: 60_000,
  },
  staleMultiplier: 3,
  staleFailureLimit: 3,
  bridgeGraceMs: 2_000,
  hostRefreshGraceMs: 1_000,
  bridgeResponseCacheTtlMs: 1_000,
  clientQueryStaleTimeMs: 1_500,
  followUpDelaysMs: [250, 1_000, 3_000],
  /**
   * User-visible reads have a bounded foreground budget.  A project may keep
   * a larger Git command timeout for background reconciliation, but that
   * value must not make a panel wait for the whole repository set.
   */
  foregroundGitTimeoutMs: 4_500,
  backendHealthTimeoutMs: 2_000,
  readBudgetsMs: {
    health: 2_000,
    versions: 2_000,
    list: 3_000,
    detail: 5_000,
    repository: 5_000,
  },
  cleanupReserveMs: 500,
} as const;

export type ObservationArea = keyof typeof OBSERVATION_TIMING_DEFAULTS.refreshIntervalsMs;

export const observationTimingSchema = z.object({
  gitTimeoutSeconds: z.number().finite().positive(),
  observationTimeoutSeconds: z.number().finite().positive(),
  cacheTtlSeconds: z.number().finite().positive(),
  observationGraceSeconds: z.number().finite().nonnegative(),
  gitTimeoutMs: z.number().int().positive(),
  observationTimeoutMs: z.number().int().positive(),
  bridgeTimeoutMs: z.number().int().positive(),
  clientRefreshTimeoutMs: z.number().int().positive(),
  cacheTtlMs: z.number().int().positive(),
  clientQueryStaleTimeMs: z.number().int().positive(),
  refreshIntervalsMs: z.object({
    list: z.number().int().positive(),
    detail: z.number().int().positive(),
    repository: z.number().int().positive(),
    review: z.number().int().positive(),
  }),
  staleWindowsMs: z.object({
    list: z.number().int().positive(),
    detail: z.number().int().positive(),
    repository: z.number().int().positive(),
    review: z.number().int().positive(),
  }),
  staleFailureLimit: z.number().int().positive(),
  followUpDelaysMs: z.array(z.number().int().nonnegative()).max(3),
  foregroundGitTimeoutMs: z.number().int().positive().default(OBSERVATION_TIMING_DEFAULTS.foregroundGitTimeoutMs),
  backendHealthTimeoutMs: z.number().int().positive().default(OBSERVATION_TIMING_DEFAULTS.backendHealthTimeoutMs),
  readBudgetsMs: z.object({
    health: z.number().int().positive(),
    versions: z.number().int().positive(),
    list: z.number().int().positive(),
    detail: z.number().int().positive(),
    repository: z.number().int().positive(),
  }).default(OBSERVATION_TIMING_DEFAULTS.readBudgetsMs),
  cleanupReserveMs: z.number().int().nonnegative().default(OBSERVATION_TIMING_DEFAULTS.cleanupReserveMs),
});

export type ObservationTiming = z.infer<typeof observationTimingSchema>;

export type ObservationReadClass = keyof typeof OBSERVATION_TIMING_DEFAULTS.readBudgetsMs;

export class ObservationTimingConfigError extends Error {
  readonly code = "config_invalid";

  constructor(message: string) {
    super(message);
    this.name = "ObservationTimingConfigError";
  }
}

function boundedNumber(
  limits: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(limits[key] ?? fallback);
  if (!Number.isFinite(value))
    throw new ObservationTimingConfigError(`invalid limit ${key}`);
  return Math.max(min, Math.min(max, value));
}

/** Resolve the complete observation policy from the project limits object. */
export function resolveObservationTiming(
  limits: Record<string, unknown> = {},
): ObservationTiming {
  const gitTimeoutSeconds = boundedNumber(
    limits,
    "gitTimeoutSeconds",
    OBSERVATION_TIMING_DEFAULTS.gitTimeoutSeconds,
    0.5,
    30,
  );
  const cacheTtlSeconds = boundedNumber(
    limits,
    "cacheTtlSeconds",
    OBSERVATION_TIMING_DEFAULTS.cacheTtlSeconds,
    0.5,
    60,
  );
  const minimumObservationSeconds =
    gitTimeoutSeconds + OBSERVATION_TIMING_DEFAULTS.observationGraceSeconds;
  const configuredObservation = limits.observationTimeoutSeconds;
  let observationTimeoutSeconds: number;
  if (configuredObservation === undefined || configuredObservation === null) {
    observationTimeoutSeconds = minimumObservationSeconds;
  } else {
    const value = Number(configuredObservation);
    if (!Number.isFinite(value))
      throw new ObservationTimingConfigError(
        "invalid limit observationTimeoutSeconds",
      );
    if (value < minimumObservationSeconds)
      throw new ObservationTimingConfigError(
        `observationTimeoutSeconds must be at least ${minimumObservationSeconds} seconds when gitTimeoutSeconds is ${gitTimeoutSeconds} seconds`,
      );
    observationTimeoutSeconds = Math.min(
      OBSERVATION_TIMING_DEFAULTS.observationTimeoutMaxSeconds,
      value,
    );
  }
  const refreshIntervalsMs = { ...OBSERVATION_TIMING_DEFAULTS.refreshIntervalsMs };
  const staleWindowsMs = Object.fromEntries(
    Object.entries(refreshIntervalsMs).map(([area, interval]) => [
      area,
      interval * OBSERVATION_TIMING_DEFAULTS.staleMultiplier,
    ]),
  ) as ObservationTiming["staleWindowsMs"];
  const gitTimeoutMs = Math.round(gitTimeoutSeconds * 1000);
  const observationTimeoutMs = Math.round(observationTimeoutSeconds * 1000);
  return {
    gitTimeoutSeconds,
    observationTimeoutSeconds,
    cacheTtlSeconds,
    observationGraceSeconds: OBSERVATION_TIMING_DEFAULTS.observationGraceSeconds,
    gitTimeoutMs,
    observationTimeoutMs,
    bridgeTimeoutMs:
      observationTimeoutMs + OBSERVATION_TIMING_DEFAULTS.bridgeGraceMs,
    clientRefreshTimeoutMs:
      observationTimeoutMs +
      OBSERVATION_TIMING_DEFAULTS.bridgeGraceMs +
      OBSERVATION_TIMING_DEFAULTS.hostRefreshGraceMs,
    cacheTtlMs: Math.round(cacheTtlSeconds * 1000),
    clientQueryStaleTimeMs: OBSERVATION_TIMING_DEFAULTS.clientQueryStaleTimeMs,
    refreshIntervalsMs,
    staleWindowsMs,
    staleFailureLimit: OBSERVATION_TIMING_DEFAULTS.staleFailureLimit,
    followUpDelaysMs: [...OBSERVATION_TIMING_DEFAULTS.followUpDelaysMs],
    foregroundGitTimeoutMs: Math.round(boundedNumber(limits, "foregroundGitTimeoutSeconds", OBSERVATION_TIMING_DEFAULTS.foregroundGitTimeoutMs / 1000, 1, 30) * 1000),
    backendHealthTimeoutMs: Math.round(boundedNumber(limits, "backendHealthTimeoutSeconds", OBSERVATION_TIMING_DEFAULTS.backendHealthTimeoutMs / 1000, 0.5, 10) * 1000),
    readBudgetsMs: {
      health: Math.round(boundedNumber(limits, "healthBudgetSeconds", OBSERVATION_TIMING_DEFAULTS.readBudgetsMs.health / 1000, 0.5, 10) * 1000),
      versions: Math.round(boundedNumber(limits, "versionsBudgetSeconds", OBSERVATION_TIMING_DEFAULTS.readBudgetsMs.versions / 1000, 0.5, 10) * 1000),
      list: Math.round(boundedNumber(limits, "listBudgetSeconds", OBSERVATION_TIMING_DEFAULTS.readBudgetsMs.list / 1000, 1, 15) * 1000),
      detail: Math.round(boundedNumber(limits, "detailBudgetSeconds", OBSERVATION_TIMING_DEFAULTS.readBudgetsMs.detail / 1000, 1, 20) * 1000),
      repository: Math.round(boundedNumber(limits, "repositoryBudgetSeconds", OBSERVATION_TIMING_DEFAULTS.readBudgetsMs.repository / 1000, 1, 20) * 1000),
    },
    cleanupReserveMs: OBSERVATION_TIMING_DEFAULTS.cleanupReserveMs,
  };
}

export const DEFAULT_OBSERVATION_TIMING = resolveObservationTiming();

/** Parse host-provided timing defensively so older backends remain usable. */
export function observationTimingFromWire(value: unknown): ObservationTiming {
  const parsed = observationTimingSchema.safeParse(value);
  if (!parsed.success) return DEFAULT_OBSERVATION_TIMING;
  return {
    ...DEFAULT_OBSERVATION_TIMING,
    ...parsed.data,
    foregroundGitTimeoutMs: parsed.data.foregroundGitTimeoutMs ?? DEFAULT_OBSERVATION_TIMING.foregroundGitTimeoutMs,
    backendHealthTimeoutMs: parsed.data.backendHealthTimeoutMs ?? DEFAULT_OBSERVATION_TIMING.backendHealthTimeoutMs,
    readBudgetsMs: parsed.data.readBudgetsMs ?? DEFAULT_OBSERVATION_TIMING.readBudgetsMs,
    cleanupReserveMs: parsed.data.cleanupReserveMs ?? DEFAULT_OBSERVATION_TIMING.cleanupReserveMs,
  };
}

export function readBudgetMs(method: string, timing: ObservationTiming = DEFAULT_OBSERVATION_TIMING): number {
  if (method === "observer.health") return timing.readBudgetsMs.health;
  if (method === "observer.versions") return timing.readBudgetsMs.versions;
  if (method === "workspace.list") return timing.readBudgetsMs.list;
  if (["workspace.detail", "workspace.orphan.preview", "review-set.compare", "review-set.brief"].includes(method)) return timing.readBudgetsMs.detail;
  if (["repository.graph", "repository.changes", "repository.diff"].includes(method)) return timing.readBudgetsMs.repository;
  return timing.readBudgetsMs.detail;
}

// Kept as a named policy value for callers that want the shared policy
// namespace without duplicating defaults or derivation rules.
export const ObservationTimingPolicy = {
  defaults: OBSERVATION_TIMING_DEFAULTS,
  resolve: resolveObservationTiming,
  fromWire: observationTimingFromWire,
} as const;
