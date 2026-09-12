import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

const sectionPreference = z.object({
  collapsed: z.boolean(),
  height: z.number().int().min(72).max(600).nullable(),
});

const sectionLayout = z.object({
  repositories: sectionPreference,
  graph: sectionPreference,
  changes: sectionPreference,
});

const reviewMode = z.enum(["split", "unified"]);

/** Host-scoped UI preferences; no repository paths or observation data live here. */
export const observerSettings = defineSettings({
  id: "workspace-workbench",
  scope: "host",
  version: 2,
  schema: z.object({
    selectedWorkspaceByPaseoWorkspace: z.record(z.string(), z.string()).default({}),
    sectionLayoutByPaseoWorkspace: z.record(z.string(), sectionLayout).default({}),
    lastProjectByHost: z.record(z.string(), z.string()).default({}),
    reviewModeByPaseoWorkspace: z.record(z.string(), reviewMode).default({}),
  }),
  migrate: (values) => {
    const previous = values && typeof values === "object" ? values as Record<string, unknown> : {};
    return {
      ...previous,
      selectedWorkspaceByPaseoWorkspace: previous.selectedWorkspaceByPaseoWorkspace || {},
      sectionLayoutByPaseoWorkspace: previous.sectionLayoutByPaseoWorkspace || {},
      lastProjectByHost: previous.lastProjectByHost || {},
      reviewModeByPaseoWorkspace: previous.reviewModeByPaseoWorkspace || {},
    };
  },
});

export const observerSettingsRpc = settingsRpc(observerSettings.id);

export type ObserverSettingsValues = z.infer<typeof observerSettings.schema>;
