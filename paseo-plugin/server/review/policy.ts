/** Existing product opt-in; browsing must never implicitly steer an Agent. */
export function reviewLifecycleEnabled(): boolean { return process.env.WORKBENCH_ENABLE_REVIEW_LIFECYCLE === "1"; }
