import { z } from "zod";

export const reviewArtifactKindSchema = z.enum(["file", "document", "prototype", "image", "pdf"]);
export type ReviewArtifactKind = z.infer<typeof reviewArtifactKindSchema>;

/**
 * A reference is intentionally metadata-only. Binary content is registered in
 * the Workbench artifact store and is addressed by assetId, never persisted in
 * a handoff or prompt as base64.
 */
export const reviewArtifactReferenceSchema = z.object({
  id: z.string().trim().min(1),
  kind: reviewArtifactKindSchema.default("file"),
  title: z.string().trim().min(1).optional(),
  purpose: z.string().trim().min(1).optional(),
  required: z.boolean().default(true),
  reading: z.string().max(4096).optional(),
  readableAlternativeIds: z.array(z.string().min(1)).max(20).optional(),
  repositoryId: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1).optional(),
  assetId: z.string().trim().min(1).optional(),
  mimeType: z.string().trim().min(1).optional(),
}).superRefine((value, ctx) => {
  const hasPath = Boolean(value.path);
  const hasAsset = Boolean(value.assetId);
  if (hasPath === hasAsset) {
    ctx.addIssue({ code: "custom", path: ["path"], message: "exactly one of path or assetId is required" });
  }
  if (value.repositoryId && !hasPath) {
    ctx.addIssue({ code: "custom", path: ["repositoryId"], message: "repositoryId requires path" });
  }
});
export type ReviewArtifactReference = z.output<typeof reviewArtifactReferenceSchema>;

export const reviewAcceptanceCriterionSchema = z.object({
  id: z.string().trim().min(1),
  text: z.string().trim().min(1),
  required: z.boolean().default(true),
});
export type ReviewAcceptanceCriterion = z.output<typeof reviewAcceptanceCriterionSchema>;

export const reviewPacketSchema = z.object({
  /** Plain-language interpretation agreed before execution starts. */
  requirementUnderstanding: z.string().trim().default(""),
  /** Human-readable plan frozen with the task. */
  plan: z.array(z.string().trim().min(1)).default([]),
  /** Stable IDs allow the Reviewer result to prove coverage. */
  acceptanceCriteria: z.array(reviewAcceptanceCriterionSchema).default([]),
  /** Files or conversation assets that are part of the review context. */
  references: z.array(reviewArtifactReferenceSchema).default([]),
  /** Per-task additions; project-level review instructions remain separate. */
  instructions: z.string().default(""),
}).superRefine((value, ctx) => {
  const checkUnique = (items: Array<{ id: string }>, path: string) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.id)) ctx.addIssue({ code: "custom", path: [path, index, "id"], message: `${path} IDs must be unique` });
      seen.add(item.id);
    });
  };
  checkUnique(value.acceptanceCriteria, "acceptanceCriteria");
  checkUnique(value.references, "references");
});
export type ReviewPacket = z.output<typeof reviewPacketSchema>;
