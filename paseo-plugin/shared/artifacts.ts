import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { reviewArtifactKindSchema } from "./review-packet.ts";

export const artifactRegister = defineRpc({
  name: "workspace.workbench.artifact.register",
  input: z.object({
    projectConfig: z.string().trim().min(1),
    token: z.string().trim().min(1),
    artifact: z.object({
      id: z.string().trim().min(1).optional(),
      title: z.string().trim().min(1),
      purpose: z.string().trim().min(1).optional(),
      kind: reviewArtifactKindSchema.optional(),
      mimeType: z.string().trim().min(1).optional(),
      /** Base64 is accepted only at this short-lived registration boundary. */
      data: z.string().trim().min(1).optional(),
      /** A file path relative to the calling Agent's working directory. */
      path: z.string().trim().min(1).optional(),
    }).superRefine((value, ctx) => {
      if (Boolean(value.data) === Boolean(value.path)) {
        ctx.addIssue({ code: "custom", path: ["data"], message: "exactly one of data or path is required" });
      }
      if (value.data && !value.mimeType) {
        ctx.addIssue({ code: "custom", path: ["mimeType"], message: "mimeType is required when data is provided" });
      }
    }),
  }),
  output: z.object({
    ok: z.boolean(),
    reference: z.object({
      id: z.string(),
      kind: reviewArtifactKindSchema,
      title: z.string().optional(),
      purpose: z.string().optional(),
      required: z.boolean(),
      assetId: z.string(),
      mimeType: z.string(),
    }).optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
});

export type ArtifactRegisterInput = z.input<typeof artifactRegister>;
export type ArtifactRegisterResponse = z.output<typeof artifactRegister.output>;

export const artifactList = defineRpc({
  name: "workspace.workbench.artifact.list",
  input: z.object({ projectConfig: z.string().trim().min(1) }),
  output: z.object({
    ok: z.boolean(),
    artifacts: z.array(z.object({
      id: z.string(),
      title: z.string(),
      purpose: z.string().optional(),
      kind: reviewArtifactKindSchema,
      mimeType: z.string(),
      size: z.number().int().nonnegative(),
      createdAt: z.string(),
    })),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
});

export type ArtifactListResponse = z.output<typeof artifactList.output>;
