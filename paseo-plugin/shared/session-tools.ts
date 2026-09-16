import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { reviewArtifactReferenceSchema } from "./review-packet.ts";

export const sessionLimits = { waitMs: 30_000, pollMs: 1_000, historyItems: 20, maxHistoryItems: 100, historyBytes: 32_768, reviewPollMs: 60_000 } as const;
export const sessionOperation = defineRpc({
  name: "workspace.workbench.session",
  input: z.object({
    projectConfig: z.string().min(1), token: z.string().min(1).optional(),
    workspaceId: z.string().min(1), action: z.enum(["status", "message", "history", "wait", "stop"]),
    requestId: z.string().min(1).optional(), text: z.string().min(1).max(32_768).optional(),
    behavior: z.enum(["steer", "interrupt"]).default("steer"),
    attachments: z.array(reviewArtifactReferenceSchema).max(20).default([]),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.object({ epoch: z.string(), seq: z.number().int() }).optional(),
    timeoutMs: z.number().int().min(0).max(30_000).default(30_000),
  }), output: z.unknown(),
});
export type SessionOperation = z.output<typeof sessionOperation.input>;
export const coordinatorReview = defineRpc({
  name: "workspace.workbench.coordinator-review",
  input: z.object({ projectConfig: z.string().min(1), token: z.string().min(1), workspaceId: z.string().min(1),
    sessionId: z.string().min(1), assignmentId: z.string().min(1), round: z.number().int().positive(), action: z.enum(["read", "result"]), result: z.unknown().optional() }),
  output: z.unknown(),
});
