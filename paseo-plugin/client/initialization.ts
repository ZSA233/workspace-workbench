// Bump this whenever the native entry or its dependency boundary changes.
// Paseo can keep an Android bundle alive across a plugin reload; a changing
// revision lets daemon.log prove which bundle actually rendered a surface.
export const INITIALIZATION_REVISION = "init-v14-native-file-review-no-versions";
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
