import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export const projectsQuery = defineRpc({
  name: "workspace.workbench.projects",
  input: z.object({}),
  output: z.array(z.object({ configPath: z.string(), sourceRoot: z.string(), workspaceRoot: z.string(), displayName: z.string() })),
});
