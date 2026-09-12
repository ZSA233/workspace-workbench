import type { GraphRow } from "../model";

export type GraphPlatform = "ios" | "android" | "web";

export type GraphTheme = {
  readonly colors: {
    readonly surface0: string;
    readonly surface2: string;
    readonly accent: string;
    readonly foregroundMuted: string;
    readonly statusSuccess: string;
    readonly statusWarning: string;
    readonly statusDanger: string;
  };
};

export type GraphCanvasProps = {
  rows: GraphRow[];
  width: number;
  height: number;
  selectedCommit: string;
  showWorktree: boolean;
  worktreeSelected: boolean;
  platform: GraphPlatform;
  theme: GraphTheme;
};
