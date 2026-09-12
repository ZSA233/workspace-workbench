import type { PluginAgentPanelProps, PluginWorkspacePanelProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { atInitializationStage } from "./initialization";
import type { WorkbenchSurfaceProps } from "./surface-context";

// Register lightweight function components, not an eagerly evaluated UI graph.
// A failed module load is reported with its phase and is never cached as success.
type PanelProps = PluginAgentPanelProps | PluginWorkspacePanelProps;
let panels: typeof import("./panel") | undefined;
let review: typeof import("./file-review") | undefined;
function loadPanels() {
  return panels ||= atInitializationStage("panel-module", () => require("./panel") as typeof import("./panel"));
}
export function WorkbenchPanel(props: PanelProps) {
  const Component = loadPanels().WorkbenchPanel;
  return <Component {...props} />;
}
export function WorkbenchSurfacePanel(props: WorkbenchSurfaceProps) {
  const Component = loadPanels().WorkbenchSurfacePanel;
  return <Component {...props} />;
}
export function FileReviewPanel(props: PanelProps) {
  review ||= atInitializationStage("diff-module", () => require("./file-review") as typeof import("./file-review"));
  const Component = review.FileReviewPanel;
  return <Component {...props} />;
}
