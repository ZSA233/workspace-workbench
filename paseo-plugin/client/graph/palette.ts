import type { GraphTheme } from "./types";
import { observerAccent } from "../theme";

export function graphLanePalette(theme: GraphTheme): string[] {
  return [
    observerAccent(theme),
    theme.colors.statusSuccess,
    theme.colors.statusWarning,
    theme.colors.statusDanger,
    "#a78bfa",
    "#2dd4bf",
    "#f472b6",
    "#60a5fa",
    "#f59e0b",
    "#84cc16",
  ];
}

export function graphLaneColor(theme: GraphTheme, colorIndex: number | undefined): string {
  const palette = graphLanePalette(theme);
  return palette[(colorIndex || 0) % palette.length];
}
