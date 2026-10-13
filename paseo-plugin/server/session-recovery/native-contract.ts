import { z } from "zod";

export const nativeRecoveryMethod = "workspace.workbench.nativeRecovery.v1";
export const nativeAttemptSchema = z.object({
  agentId: z.string().min(1), attemptId: z.string().min(1).max(200), identity: z.string().length(64),
  lastUserMessageAt: z.string().nullable(), failedTurnId: z.string().min(1),
});
export type NativeAttempt = z.infer<typeof nativeAttemptSchema>;
export const nativeOutcomeSchema = z.object({ kind: z.enum(["completed", "failed", "canceled"]), error: z.object({ message: z.string() }).optional() });
export type NativeOutcome = z.infer<typeof nativeOutcomeSchema>;
export const nativeReceiptSchema = z.object({
  agentId: z.string(), attemptId: z.string(), status: z.enum(["dispatching", "accepted", "uncertain", "rejected", "finished"]),
  turnId: z.string().nullable(), outcome: nativeOutcomeSchema.nullable(), error: z.string().nullable(),
});
export type NativeReceipt = z.infer<typeof nativeReceiptSchema>;
