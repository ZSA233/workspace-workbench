import {WorkbenchThemeProvider,useWorkbenchThemeColors,type TextThemeColors} from "./theme-context";
import type { PluginAgentPanelProps,PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { createElement,useEffect,useState,type ComponentType } from "react";
import { Text,View } from "react-native";
import { copy } from "../shared/copy";
import { CLIENT_GENERATION } from "./initialization";
import { reportNativeDiagnostic } from "./native-diagnostics";
import type { WorkbenchSurfaceProps } from "./surface-context";

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
  return <WorkbenchThemeProvider colors={(props as {theme?:{colors:TextThemeColors}}).theme?.colors}>{error?<NativePanelLoadFailure name={name} error={error}/>:!component?<NativePanelShell name={name}/>:createElement(component,props)}</WorkbenchThemeProvider>;
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
  const colors=useWorkbenchThemeColors();
  reportNativeDiagnostic("render_shell", { entry: name, phase: "render_shell" });
  return <View style={{ flex: 1, padding: 12, gap: 6,backgroundColor:colors.surface0 }}><Text style={{color:colors.foreground}}>{copy.projectLoading}</Text><Text selectable style={{color:colors.foregroundMuted}}>{`${name} · ${CLIENT_GENERATION}`}</Text></View>;
}

function NativePanelLoadFailure({ name, error }: { name: string; error: string }) {
  const colors=useWorkbenchThemeColors();
  reportNativeDiagnostic("component-resolution-failed", { componentName: name, phase: "component_resolution", error: error.slice(0, 1000), generation: CLIENT_GENERATION });
  return <View style={{ flex: 1, padding: 12, gap: 6,backgroundColor:colors.surface0 }}><Text style={{color:colors.foreground}}>{copy.openFailed}</Text><Text selectable style={{color:colors.foregroundMuted}}>{`${name} · ${CLIENT_GENERATION}`}</Text><Text selectable style={{color:colors.foreground}}>{error.slice(0, 1200)}</Text></View>;
}
