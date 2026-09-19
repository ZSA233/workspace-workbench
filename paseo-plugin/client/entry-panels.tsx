import type { PluginAgentPanelProps, PluginWorkspacePanelProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { View } from "react-native";
import type { ReactNode } from "react";
import type { WorkbenchSurfaceProps } from "./surface-context";
import { reportNativeDiagnostic } from "./native-diagnostics";
import {
  WorkbenchPanel as WorkbenchPanelImplementation,
  WorkbenchSurfacePanel as WorkbenchSurfacePanelImplementation,
} from "./panel";
import { FileReviewPanel as FileReviewPanelImplementation } from "./file-review";
import { PanelErrorBoundary } from "./panel-error-boundary";

type PanelProps = PluginAgentPanelProps | PluginWorkspacePanelProps;

function reportStaticPanelLoad(): void {
  reportNativeDiagnostic("panel-module-static-loaded", { exports: "ObserverPanelContent,WorkbenchPanel,WorkbenchSurfacePanel,FileReviewPanel" });
}
export function WorkbenchPanel(props: PanelProps) {
  reportStaticPanelLoad();
  reportNativeDiagnostic("panel-entry", { kind: props.context, workspaceId: props.workspaceId });
  const Component = WorkbenchPanelImplementation;
  reportNativeDiagnostic("panel-component-resolved", { kind: "workspace", type: componentType(Component) });
  if (!isComponent(Component)) return <NativePanelLoadFailure name="WorkbenchPanel" />;
  return <PanelErrorBoundary><Component {...props} /></PanelErrorBoundary>;
}
export function WorkbenchSurfacePanel(props: WorkbenchSurfaceProps) {
  reportStaticPanelLoad();
  reportNativeDiagnostic("surface-entry", { workspaceId: props.target?.workspaceId || "" });
  const Component = WorkbenchSurfacePanelImplementation;
  reportNativeDiagnostic("panel-component-resolved", { kind: "surface", type: componentType(Component) });
  if (!isComponent(Component)) return <NativePanelLoadFailure name="WorkbenchSurfacePanel" />;
  return <PanelErrorBoundary><Component {...props} /></PanelErrorBoundary>;
}
export function FileReviewPanel(props: PanelProps) {
  reportStaticPanelLoad();
  reportNativeDiagnostic("file-panel-entry", { kind: props.context, workspaceId: props.workspaceId });
  const Component = FileReviewPanelImplementation;
  reportNativeDiagnostic("panel-component-resolved", { kind: "file", type: componentType(Component) });
  if (!isComponent(Component)) return <NativePanelLoadFailure name="FileReviewPanel" />;
  return <PanelErrorBoundary><Component {...props} /></PanelErrorBoundary>;
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
