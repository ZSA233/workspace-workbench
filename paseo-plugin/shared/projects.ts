import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export const projectsQuery = defineRpc({
  name: "workspace.workbench.projects",
  input: z.object({ directory: z.string().trim().min(1).optional() }),
  output: z.array(z.object({ configPath: z.string(), sourceRoot: z.string(), workspaceRoot: z.string(), displayName: z.string() })),
});

export type ProjectInfo = z.infer<typeof projectsQuery.output>[number];
