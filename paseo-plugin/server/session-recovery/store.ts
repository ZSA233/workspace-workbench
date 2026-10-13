import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { recoveryStatusSchema } from "../../shared/session-recovery.ts";

export const recoveryRecordSchema = z.object({
  agentId: z.string(), workspaceId: z.string().nullable(), workspaceName: z.string(), title: z.string(),
  role: z.string().nullable(), connectedToWorkbench: z.boolean(), archived: z.boolean().default(false),
  status: recoveryStatusSchema, attempt: z.number().int().nonnegative(), nextAttemptAt: z.number().nullable(), deadlineAt: z.number().nullable(),
  reason: z.string().nullable(), updatedAt: z.number(), episodeId: z.string().nullable(), firstFailureAt: z.number().nullable(),
  failedTurnId: z.string().nullable(), recoveryTurnId: z.string().nullable(), messageId: z.string().nullable(),
  attemptStartedAt: z.number().nullable().default(null),
  deliveryKind: z.enum(["message", "native"]).default("message"),
  identity: z.string().nullable(), lastUserMessageAt: z.string().nullable(), taskGuard: z.string().nullable(),
}).passthrough();
export type RecoveryRecord = z.output<typeof recoveryRecordSchema>;
const fileSchema = z.object({ version: z.literal(1), serverId: z.string(), records: z.record(z.string(), recoveryRecordSchema) }).passthrough();
export interface RecoveryStorage { load(): RecoveryRecord[]; save(records: RecoveryRecord[]): void; close(): void }
export function recoveryStorageLocation(): { directory: string; serverId: string } {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  // A port can change across daemon restarts; the persisted service ID cannot.
  const serverId = readFileSync(join(home, "server-id"), "utf8").trim();
  if (!serverId) throw new Error("recovery_server_identity_unavailable");
  const key = createHash("sha256").update(serverId).digest("hex").slice(0, 24);
  return { directory: join(home, "workspace-workbench", "recovery", key), serverId };
}
export class RecoveryDiskStore implements RecoveryStorage {
  private owner = { pid: process.pid, generation: randomUUID() };
  private previous: Record<string, unknown> = {};
  private closed = false;
  private lock: string;
  private file: string;
  constructor(privateDirectory: string, privateServerId: string) {
    this.directory = privateDirectory; this.serverId = privateServerId;
    this.lock = join(this.directory, "owner.lock"); this.file = join(this.directory, "state.json");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try { mkdirSync(this.lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const old = JSON.parse(readFileSync(join(this.lock, "owner.json"), "utf8")) as { pid?: unknown; generation?: unknown };
      if (!Number.isSafeInteger(old.pid) || Number(old.pid) <= 0 || typeof old.generation !== "string") throw new Error("recovery_owner_unverified");
      try { process.kill(Number(old.pid), 0); throw new Error("recovery_owner_busy"); }
      catch (check) { if ((check as NodeJS.ErrnoException).code !== "ESRCH") throw check; }
      // Serialize reclaimers under the dead owner's directory so two startup
      // processes cannot remove a replacement owner's lock after a stale read.
      const reclaim = join(this.lock, "reclaim");
      try { mkdirSync(reclaim, { mode: 0o700 }); } catch { throw new Error("recovery_owner_busy"); }
      writeFileSync(join(reclaim, "generation"), this.owner.generation);
      try {
        const fresh = JSON.parse(readFileSync(join(this.lock, "owner.json"), "utf8"));
        if (fresh.generation !== old.generation || fresh.pid !== old.pid) throw new Error("recovery_owner_changed");
        try { process.kill(Number(fresh.pid), 0); throw new Error("recovery_owner_busy"); }
        catch (check) { if ((check as NodeJS.ErrnoException).code !== "ESRCH") throw check; }
        // Only a proven exited owner can be reclaimed; never signal a process.
        rmSync(this.lock, { recursive: true }); mkdirSync(this.lock, { mode: 0o700 });
      } finally {
        try { if (readFileSync(join(reclaim, "generation"), "utf8") === this.owner.generation) rmSync(reclaim, { recursive: true }); } catch { /* Reclaimed directory is already gone. */ }
      }
    }
    writeFileSync(join(this.lock, "owner.json"), JSON.stringify(this.owner), { mode: 0o600 });
  }
  private directory: string;
  private serverId: string;
  private owns(): boolean {
    if (this.closed) return false;
    try { return JSON.parse(readFileSync(join(this.lock, "owner.json"), "utf8")).generation === this.owner.generation; } catch { return false; }
  }
  load(): RecoveryRecord[] {
    if (!existsSync(this.file)) return [];
    const data = fileSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    if (data.serverId !== this.serverId) throw new Error("recovery_server_identity_changed");
    this.previous = data;
    return Object.values(data.records);
  }
  save(records: RecoveryRecord[]): void {
    if (!this.owns()) throw new Error("recovery_generation_retired");
    const temporary = `${this.file}.${this.owner.generation}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...this.previous, version: 1, serverId: this.serverId, records: Object.fromEntries(records.map(r => [r.agentId, r])) }), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
  close(): void {
    if (this.owns()) rmSync(this.lock, { recursive: true });
    this.closed = true;
  }
}
