import type { PluginAgentPanelProps, PluginWorkspacePanelProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { createElement, useEffect, useState, type ComponentType, type ReactNode } from "react";
import type { WorkbenchSurfaceProps } from "./surface-context";
import { reportNativeDiagnostic } from "./native-diagnostics";
import { CLIENT_GENERATION } from "./initialization";
import { copy } from "../shared/copy";

type PanelProps = PluginAgentPanelProps | PluginWorkspacePanelProps;

type PanelProps = PluginAgentPanelProps | PluginWorkspacePanelProps;
type DeferredProps = { name: string; loader: () => Promise<Record<string, unknown>>; exportName: string; props: object };

function reportStaticPanelLoad(): void {
  reportNativeDiagnostic("panel-module-static-loaded", { exports: "deferred", generation: CLIENT_GENERATION });
}

function DeferredPanel({ name, loader, exportName, props }: DeferredProps) {
  const [component, setComponent] = useState<ComponentType<any> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    reportNativeDiagnostic("component_load_started", { entry: name, phase: "component_resolution", componentName: exportName });
    void loader().then((module) => {
      if (!active) return;
      const candidate = module[exportName];
      if (typeof candidate !== "function") {
        const message = `${exportName} export is ${candidate === undefined ? "undefined" : typeof candidate}`;
        reportNativeDiagnostic("component_resolution_failed", { entry: name, phase: "component_resolution", componentName: exportName, errorCode: "component_export_missing", message });
        setError(message);
        return;
      }
      reportNativeDiagnostic("component_load_finished", { entry: name, phase: "component_resolution", componentName: exportName });
      setComponent(() => candidate as ComponentType<any>);
    }).catch((reason) => {
      if (!active) return;
      const message = reason instanceof Error ? `${reason.message}\n${reason.stack || ""}` : String(reason);
      reportNativeDiagnostic("component_load_failed", { entry: name, phase: "component_resolution", componentName: exportName, errorCode: /prototype|Element type is invalid/i.test(message) ? "native_dependency_error" : "component_import_failed", message });
      setError(message);
    });
    return () => { active = false; };
  }, [exportName, loader, name]);
  if (error) return <NativePanelLoadFailure name={name} error={error} />;
  if (!component) return <NativePanelShell name={name} />;
  return createElement(component, props);
}

export function WorkbenchPanel(props: PanelProps) {
  reportStaticPanelLoad();
  reportNativeDiagnostic("panel-entry", { kind: props.context, workspaceId: props.workspaceId });
  return <DeferredPanel name="WorkbenchPanel" loader={() => import("./panel")} exportName="WorkbenchPanel" props={props} />;
}
export function WorkbenchSurfacePanel(props: WorkbenchSurfaceProps) {
  reportStaticPanelLoad();
  reportNativeDiagnostic("surface-entry", { workspaceId: props.target?.workspaceId || "" });
  return <DeferredPanel name="WorkbenchSurfacePanel" loader={() => import("./panel")} exportName="WorkbenchSurfacePanel" props={props} />;
}
export function FileReviewPanel(props: PanelProps) {
  reportStaticPanelLoad();
  reportNativeDiagnostic("file-panel-entry", { kind: props.context, workspaceId: props.workspaceId });
  return <DeferredPanel name="FileReviewPanel" loader={() => import("./file-review")} exportName="FileReviewPanel" props={props} />;
}

function NativePanelShell({ name }: { name: string }) {
  reportNativeDiagnostic("render_shell", { entry: name, phase: "render_shell" });
  return <View style={{ flex: 1, padding: 12, gap: 6 }}><Text>{copy.projectLoading}</Text><Text selectable>{`${name} · ${CLIENT_GENERATION}`}</Text></View>;
}

function NativePanelLoadFailure({ name, error }: { name: string; error: string }) {
  reportNativeDiagnostic("component-resolution-failed", { componentName: name, phase: "component_resolution", error: error.slice(0, 1000), generation: CLIENT_GENERATION });
  return <View style={{ flex: 1, padding: 12, gap: 6 }}><Text>{copy.openFailed}</Text><Text selectable>{`${name} · ${CLIENT_GENERATION}`}</Text><Text selectable>{error.slice(0, 1200)}</Text></View>;
}
