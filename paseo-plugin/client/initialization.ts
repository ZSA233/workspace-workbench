// Bump this whenever the native entry or its dependency boundary changes.
// Paseo can keep an Android bundle alive across a plugin reload; a changing
// revision lets daemon.log prove which bundle actually rendered a surface.
export const INITIALIZATION_REVISION = "init-v21-android-server-only-recovery";
export const CLIENT_GENERATION = `client-${INITIALIZATION_REVISION}`;

export function atInitializationStage<T>(stage: string, load: () => T): T {
  try { return load(); }
  catch (error) {
    const prefix = `[workbench/${INITIALIZATION_REVISION}/${stage}]`;
    const original = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
    console.error(prefix, error && typeof error === "object" && "stack" in error ? error.stack : original);
    if (error && typeof error === "object" && "message" in error) {
      error.message = `${prefix} ${original}`;
      throw error;
    }
    throw new Error(`${prefix} ${original}`);
  }
}

type RegistrationReporter = (phase: string, details: Record<string, string>) => void;

/** Each registration owns its cleanup, including partially completed setup. */
export function createRegistrationScope(report: RegistrationReporter) {
  const cleanups: Array<() => void> = [];
  let closed = false;
  function emit(phase: string, details: Record<string, string>) {
    try { report(phase, details); } catch { /* diagnostics cannot break setup */ }
  }
  function failure(stage: string, error: unknown) {
    const value = error as { message?: unknown; stack?: unknown; name?: unknown } | null;
    emit("registration-failed", { stage, message: String(value?.message ?? error), stack: String(value?.stack ?? ""), errorName: String(value?.name ?? "Error") });
  }
  function step<T>(stage: string, setup: () => T): T {
    if (closed) throw new Error("client_registration_closed");
    emit("registration-before", { stage });
    try {
      const value = atInitializationStage(stage, setup);
      emit("registration-after", { stage });
      return value;
    } catch (error) { failure(stage, error); throw error; }
  }
  function own(stage: string, cleanup: () => void): () => void {
    let active = true;
    const remove = () => {
      if (!active) return;
      active = false;
      try { cleanup(); } catch (error) { failure(`${stage}:cleanup`, error); }
    };
    if (closed) remove(); else cleanups.push(remove);
    return remove;
  }
  function register(stage: string, setup: () => () => void) {
    return own(stage, step(stage, setup));
  }
  function optional(stage: string, setup: () => () => void) {
    try { return register(stage, setup); } catch { return () => {}; }
  }
  function close() {
    if (closed) return;
    closed = true;
    while (cleanups.length) cleanups.pop()!();
  }
  return { step, own, register, optional, failure, close };
}
export type RegistrationScope = ReturnType<typeof createRegistrationScope>;
