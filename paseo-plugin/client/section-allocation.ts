import type { ObserverSectionLayout } from "./model";

export function allocateSections(height: number, layout: ObserverSectionLayout, chromeHeight = 132, contentHeights: Partial<Record<keyof ObserverSectionLayout, number>> = {}) {
  const ids = ["repositories", "graph", "changes"] as const;
  const open = ids.filter((id) => !layout[id].collapsed);
  const budget = Math.max(0, height - chromeHeight);
  const outerScroll = budget < open.length * 72;
  const sizes = { repositories: 0, graph: 0, changes: 0 };
  if (!open.length) return { sizes, outerScroll };
  const desired = open.map((id) => id === "changes" ? 160 : Math.max(72, Math.min(600, layout[id].height || Math.min(contentHeights[id] || Infinity, id === "repositories" ? 220 : 280))));
  if (outerScroll) open.forEach((id, index) => { sizes[id] = desired[index]; });
  else {
    let remaining = budget;
    open.forEach((id, index) => {
      const later = open.length - index - 1;
      sizes[id] = later === 0 ? remaining : Math.min(desired[index], remaining - later * 72);
      remaining -= sizes[id];
    });
  }
  return { sizes, outerScroll };
}
