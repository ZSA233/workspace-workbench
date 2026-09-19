import { Component, type ErrorInfo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { copy } from "../shared/copy";
import { reportNativeDiagnostic } from "./native-diagnostics";
import { Platform } from "react-native";
import { CLIENT_GENERATION } from "./initialization";

type Props = { children: ReactNode; entry?: string };
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
      errorName: error.name,
      entry: this.props.entry || "panel",
      stage: "render_shell",
      generation: CLIENT_GENERATION,
      stack: error.stack || "",
      componentStack: info.componentStack || "",
      platform: Platform.OS,
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const diagnostic = JSON.stringify({
      generation: CLIENT_GENERATION,
      entry: this.props.entry || "panel",
      phase: "render_shell",
      name: this.state.error.name,
      message: this.state.error.message,
    }, null, 2);
    return (
      <View style={{ flex: 1, padding: 12, gap: 8 }}>
        <Text style={{ fontWeight: "700" }}>{copy.openFailed}</Text>
        <Text selectable>{`${this.state.error.name}: ${this.state.error.message}`}</Text>
        <Text selectable style={{ opacity: 0.75 }}>{diagnostic}</Text>
        <Text accessibilityRole="button" onPress={() => this.setState({ error: null })}>{copy.setupRetry}</Text>
      </View>
    );
  }
}
