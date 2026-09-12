import { allocateSections } from "./section-allocation.ts";
import type { ObserverSectionId, ObserverSectionLayout } from "./model";

export function beginResize(id: ObserverSectionId, height: number, chrome: number, layout: ObserverSectionLayout, content: Record<string, number>) {
  const initial = allocateSections(height, layout, chrome, content);
  const ids = ["repositories", "graph", "changes"] as const;
  const after = ids.slice(ids.indexOf(id) + 1).filter((key) => !layout[key].collapsed);
  if (id === "changes" || layout[id].collapsed || initial.outerScroll || !after.length) return null;
  const before = ids.slice(0, ids.indexOf(id)).reduce((sum, key) => sum + initial.sizes[key], 0);
  const max = Math.min(600, height - chrome - before - after.length * 72);
  const frozen = Object.fromEntries(ids.map((key) => [key, { ...layout[key], height: initial.sizes[key] }])) as ObserverSectionLayout;
  return {
    id, initial,
    update(dy: number) {
      const value = Math.round(Math.max(72, Math.min(max, initial.sizes[id] + dy)));
      const next = { ...frozen, [id]: { ...frozen[id], height: value } };
      return { value, allocation: allocateSections(height, next, chrome, content) };
    },
  };
}
