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
});

export type ObservationTiming = z.infer<typeof observationTimingSchema>;

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
  };
}

export const DEFAULT_OBSERVATION_TIMING = resolveObservationTiming();

/** Parse host-provided timing defensively so older backends remain usable. */
export function observationTimingFromWire(value: unknown): ObservationTiming {
  const parsed = observationTimingSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_OBSERVATION_TIMING;
}

// Kept as a named policy value for callers that want the shared policy
// namespace without duplicating defaults or derivation rules.
export const ObservationTimingPolicy = {
  defaults: OBSERVATION_TIMING_DEFAULTS,
  resolve: resolveObservationTiming,
  fromWire: observationTimingFromWire,
} as const;
