import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

export const bundleRefSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), version: z.number().int().positive() });
export type BundleRef = z.output<typeof bundleRefSchema>;
const sourcedEntry = z.object({ text: z.string().min(1).max(16_384), sources: z.array(z.string().min(1).max(512)).max(20).default([]) });
export const handoffContextSchema = z.object({
  understanding: z.array(sourcedEntry).max(100).default([]),
  requirements: z.array(sourcedEntry).max(100).default([]),
  preferences: z.array(sourcedEntry).max(100).default([]),
  decisions: z.array(sourcedEntry.extend({ reason: z.string().max(16_384).default("") })).max(100).default([]),
  rejectedAlternatives: z.array(sourcedEntry.extend({ reason: z.string().max(16_384).default("") })).max(100).default([]),
  assumptions: z.array(sourcedEntry).max(100).default([]),
});
export const materialLimits = { readBytes: 16_384, searchHits: 20, archiveBytes: 8 * 1024 * 1024, archivePages: 100, totalBytes: 64 * 1024 * 1024, pageItems: 100, archiveTimeoutMs: 15_000 } as const;
export const handoffMaterials = defineRpc({
  name: "workspace.workbench.handoff-materials",
  input: z.object({ projectConfig: z.string().min(1), workspaceId: z.string().min(1).optional(), token: z.string().min(1).optional(),
    bundle: bundleRefSchema.optional(), action: z.enum(["read", "search", "asset"]).default("read"),
    file: z.string().min(1).max(200).default("HANDOFF.md"), offset: z.number().int().nonnegative().default(0),
    query: z.string().min(1).max(200).optional(), sourceId: z.string().min(1).max(200).optional(),
  }), output: z.unknown(),
});
export type MaterialRequest = z.output<typeof handoffMaterials.input>;
