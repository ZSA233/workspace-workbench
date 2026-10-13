import type { RecoveryFailure } from "./errors.ts";
export interface RecoveryCoordinator {
  claimFailure(agentId: string, turnId: string | null, error: RecoveryFailure): Promise<boolean>;
  cancel(agentId: string, reason?: string): Promise<void>;
}
let current: RecoveryCoordinator | null = null;
export function installRecoveryCoordinator(value: RecoveryCoordinator): () => void {
  current = value;
  return () => { if (current === value) current = null; };
}
export async function claimSessionRecovery(agentId: string, turnId: string | null, error: RecoveryFailure): Promise<boolean> {
  return current ? current.claimFailure(agentId, turnId, error) : false;
}
export async function cancelSessionRecovery(agentId: string, reason: string): Promise<void> { await current?.cancel(agentId, reason); }
