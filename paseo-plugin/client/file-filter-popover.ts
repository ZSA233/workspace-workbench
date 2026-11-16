export type FilterPopoverAnchor = { x: number; y: number; width: number; height: number };
export function filterPopoverPlacement(anchor: FilterPopoverAnchor, bounds: { x: number; width: number; y?: number; height?: number } | undefined, viewport: { width: number; height: number }, desiredHeight = 420, desiredWidth = 340) {
  const leftEdge = Math.max(8, bounds ? bounds.x + 4 : 8);
  const rightEdge = Math.min(viewport.width - 8, bounds ? bounds.x + bounds.width - 4 : viewport.width - 8);
  const width = Math.max(0, Math.min(desiredWidth, rightEdge - leftEdge));
  const left = Math.max(leftEdge, Math.min(anchor.x + anchor.width - width, rightEdge - width));
  const topEdge=Math.max(8,bounds?.y!==undefined?bounds.y+4:8),bottomEdge=Math.min(viewport.height-8,bounds?.y!==undefined&&bounds.height!==undefined?bounds.y+bounds.height-4:viewport.height-8);
  const available = Math.max(0, bottomEdge-topEdge), height = Math.min(available, desiredHeight);
  const below = anchor.y + anchor.height + 4;
  const top = below + height <= bottomEdge ? Math.max(topEdge,below) : Math.max(topEdge, Math.min(anchor.y - height - 4, bottomEdge-height));
  return { left, top, width, maxHeight: Math.max(0, bottomEdge-top) };
}
