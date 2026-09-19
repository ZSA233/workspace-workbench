import type { PluginAgentPanelProps, PluginWorkspacePanelProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { atInitializationStage } from "./initialization";
import type { WorkbenchSurfaceProps } from "./surface-context";
import { PanelErrorBoundary } from "./panel-error-boundary";
import { reportNativeDiagnostic } from "./native-diagnostics";

// Register lightweight function components, not an eagerly evaluated UI graph.
// A failed module load is reported with its phase and is never cached as success.
type PanelProps = PluginAgentPanelProps | PluginWorkspacePanelProps;
let panels: typeof import("./panel") | undefined;
let review: typeof import("./file-review") | undefined;
function loadPanels() {
  if (panels) return panels;
  reportNativeDiagnostic("panel-module-before-load");
  try {
    panels = atInitializationStage("panel-module", () => require("./panel") as typeof import("./panel"));
    reportNativeDiagnostic("panel-module-loaded", { exports: Object.keys(panels).sort().join(",") });
    return panels;
  } catch (error) {
    reportNativeDiagnostic("panel-module-failed", { message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
export function WorkbenchPanel(props: PanelProps) {
  reportNativeDiagnostic("panel-entry", { kind: props.context, workspaceId: props.workspaceId });
  return <PanelErrorBoundary><LazyWorkbenchPanel {...props} /></PanelErrorBoundary>;
}
function LazyWorkbenchPanel(props: PanelProps) {
  const Component = loadPanels().WorkbenchPanel;
  return <Component {...props} />;
}
export function WorkbenchSurfacePanel(props: WorkbenchSurfaceProps) {
  reportNativeDiagnostic("surface-entry", { workspaceId: props.target?.workspaceId || "" });
  return <PanelErrorBoundary><LazyWorkbenchSurfacePanel {...props} /></PanelErrorBoundary>;
}
function LazyWorkbenchSurfacePanel(props: WorkbenchSurfaceProps) {
  const Component = loadPanels().WorkbenchSurfacePanel;
  return <Component {...props} />;
}
export function FileReviewPanel(props: PanelProps) {
  reportNativeDiagnostic("file-panel-entry", { kind: props.context, workspaceId: props.workspaceId });
  return <PanelErrorBoundary><LazyFileReviewPanel {...props} /></PanelErrorBoundary>;
}
function LazyFileReviewPanel(props: PanelProps) {
  review ||= atInitializationStage("diff-module", () => require("./file-review") as typeof import("./file-review"));
  const Component = review.FileReviewPanel;
  return <Component {...props} />;
}
