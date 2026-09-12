export type Point = { x: number; y: number };

// Both renderers use exactly the same cubic, including its vertical tangents.
export function curvePath(a: Point, b: Point): string {
  const bend = Math.min(8, Math.abs(b.y - a.y) / 2);
  return `M ${a.x} ${a.y} C ${a.x} ${a.y + bend}, ${b.x} ${b.y - bend}, ${b.x} ${b.y}`;
}

export function sampleCurve(a: Point, b: Point): Point[] {
  const bend = Math.min(8, Math.abs(b.y - a.y) / 2);
  const steps = Math.max(4, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 3));
  return Array.from({ length: steps + 1 }, (_, i) => {
    if (i === 0) return a;
    if (i === steps) return b;
    const t = i / steps, u = 1 - t;
    return {
      x: u ** 3 * a.x + 3 * u * u * t * a.x + 3 * u * t * t * b.x + t ** 3 * b.x,
      y: u ** 3 * a.y + 3 * u * u * t * (a.y + bend) + 3 * u * t * t * (b.y - bend) + t ** 3 * b.y,
    };
  });
}
