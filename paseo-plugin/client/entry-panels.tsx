import type { PluginAgentPanelProps, PluginWorkspacePanelProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { View } from "react-native";
import type { ReactNode } from "react";
import { atInitializationStage } from "./initialization";
import type { WorkbenchSurfaceProps } from "./surface-context";
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
  return <LazyWorkbenchPanel {...props} />;
}
function LazyWorkbenchPanel(props: PanelProps) {
  const Component = loadPanels().WorkbenchPanel;
  reportNativeDiagnostic("panel-component-resolved", { kind: "workspace", type: componentType(Component) });
  if (!isComponent(Component)) return <NativePanelLoadFailure name="WorkbenchPanel" />;
  return <Component {...props} />;
}
export function WorkbenchSurfacePanel(props: WorkbenchSurfaceProps) {
  reportNativeDiagnostic("surface-entry", { workspaceId: props.target?.workspaceId || "" });
  return <LazyWorkbenchSurfacePanel {...props} />;
}
function LazyWorkbenchSurfacePanel(props: WorkbenchSurfaceProps) {
  const Component = loadPanels().WorkbenchSurfacePanel;
  reportNativeDiagnostic("panel-component-resolved", { kind: "surface", type: componentType(Component) });
  if (!isComponent(Component)) return <NativePanelLoadFailure name="WorkbenchSurfacePanel" />;
  return <Component {...props} />;
}
export function FileReviewPanel(props: PanelProps) {
  reportNativeDiagnostic("file-panel-entry", { kind: props.context, workspaceId: props.workspaceId });
  return <LazyFileReviewPanel {...props} />;
}
function LazyFileReviewPanel(props: PanelProps) {
  review ||= atInitializationStage("diff-module", () => require("./file-review") as typeof import("./file-review"));
  const Component = review.FileReviewPanel;
  reportNativeDiagnostic("panel-component-resolved", { kind: "file", type: componentType(Component) });
  if (!isComponent(Component)) return <NativePanelLoadFailure name="FileReviewPanel" />;
  return <Component {...props} />;
}

function isComponent(value: unknown): value is (props: any) => ReactNode {
  return typeof value === "function";
}

function componentType(value: unknown): string {
  return typeof value === "function" ? `function:${value.name || "anonymous"}` : value === undefined ? "undefined" : value === null ? "null" : typeof value;
}

function NativePanelLoadFailure({ name }: { name: string }) {
  void name;
  return <View />;
}
