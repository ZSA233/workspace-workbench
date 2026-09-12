import { GraphCanvasNative } from "./canvas-native";
import { GraphCanvasWeb } from "./canvas-web";
import type { GraphCanvasProps } from "./types";

/**
 * Platform dispatch is intentionally kept at the renderer boundary. The
 * Observer panel supplies Git rows; each renderer owns its drawing details.
 */
export function GraphCanvas(props: GraphCanvasProps) {
  return props.platform === "web"
    ? <GraphCanvasWeb {...props} />
    : <GraphCanvasNative {...props} />;
}
