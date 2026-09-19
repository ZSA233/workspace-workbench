import { Component, type ErrorInfo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { copy } from "../shared/copy";
import { reportNativeDiagnostic } from "./native-diagnostics";
import { Platform } from "react-native";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Native hosts can have a smaller component surface than the web host. Keep a
 * single optional panel failure from taking down the whole plugin surface and
 * leave the actual error visible for diagnosis.
 */
export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("workbench_panel_render_failed", error, info.componentStack);
    reportNativeDiagnostic("panel-render-failed", {
      message: error.message,
      stack: error.stack || "",
      componentStack: info.componentStack || "",
      platform: Platform.OS,
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <View style={{ flex: 1, padding: 12, gap: 8 }}>
        <Text style={{ fontWeight: "700" }}>{copy.openFailed}</Text>
        <Text selectable>{this.state.error.message}</Text>
      </View>
    );
  }
}
