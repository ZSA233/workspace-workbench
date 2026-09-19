import type { PluginAgentPanelProps, PluginWorkspacePanelProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { ReactNode } from "react";
import type { WorkbenchSurfaceProps } from "./surface-context";
import { reportNativeDiagnostic } from "./native-diagnostics";
import {
  WorkbenchPanel as WorkbenchPanelImplementation,
  WorkbenchSurfacePanel as WorkbenchSurfacePanelImplementation,
} from "./panel";
import { FileReviewPanel as FileReviewPanelImplementation } from "./file-review";
import { CLIENT_GENERATION } from "./initialization";
import { copy } from "../shared/copy";

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
  // Do not wrap native entries in a React error boundary. The Android host's
  // renderer does not support this boundary shape and reports it as an
  // undefined element before the implementation component is entered.
  return <Component {...props} />;
}
export function WorkbenchSurfacePanel(props: WorkbenchSurfaceProps) {
  reportStaticPanelLoad();
  reportNativeDiagnostic("surface-entry", { workspaceId: props.target?.workspaceId || "" });
  const Component = WorkbenchSurfacePanelImplementation;
  reportNativeDiagnostic("panel-component-resolved", { kind: "surface", type: componentType(Component) });
  if (!isComponent(Component)) return <NativePanelLoadFailure name="WorkbenchSurfacePanel" />;
  return <Component {...props} />;
}
export function FileReviewPanel(props: PanelProps) {
  reportStaticPanelLoad();
  reportNativeDiagnostic("file-panel-entry", { kind: props.context, workspaceId: props.workspaceId });
  const Component = FileReviewPanelImplementation;
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
  reportNativeDiagnostic("component-resolution-failed", { componentName: name, stage: "component_resolution", generation: CLIENT_GENERATION });
  return <View style={{ flex: 1, padding: 12, gap: 6 }}><Text>{copy.openFailed}</Text><Text selectable>{`${name} · ${CLIENT_GENERATION}`}</Text></View>;
}
