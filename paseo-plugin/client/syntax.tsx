import { createElement, memo, useEffect, useState, type ComponentType, type ReactElement } from "react";
import { Platform, Text, type StyleProp, type TextStyle } from "react-native";

/**
 * Keep the native entry free of Prism and its grammar modules.
 *
 * Prism's browser entry (and some of the grammar loading paths around it)
 * assumes DOM constructors such as Element are present. Android surfaces can
 * load this module while they are opening a diff, so even a platform check
 * around a static import is too late: the imported module has already run.
 * The web implementation is therefore loaded only after a web renderer has
 * explicitly mounted. Native gets a plain, selectable Text fallback.
 */

export type SyntaxTheme = {
  colors: {
    surface0: string;
    foreground: string;
    foregroundMuted: string;
  };
};

export type HighlightedCodeProps = {
  code: string;
  path: string;
  theme: SyntaxTheme;
  style?: StyleProp<TextStyle>;
};

export const editorCodeFontFamily = Platform.OS === "web"
  ? 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace'
  : Platform.OS === "ios"
    ? "Menlo"
    : "monospace";

type WebSyntaxModule = typeof import("./syntax-web");

function PlainCode({ code, theme, style }: HighlightedCodeProps): ReactElement {
  return (
    <Text
      selectable
      style={[
        style,
        { color: theme.colors.foreground, fontFamily: editorCodeFontFamily } as TextStyle,
      ]}
    >
      {code || " "}
    </Text>
  );
}

function WebHighlightedCode(props: HighlightedCodeProps): ReactElement {
  const [webRenderer, setWebRenderer] = useState<ComponentType<HighlightedCodeProps> | null>(null);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    let active = true;
    void import("./syntax-web").then((module: WebSyntaxModule) => {
      if (active) setWebRenderer(() => module.HighlightedCode);
    }).catch(() => {
      // Plain text remains a useful and safe fallback if the optional web
      // highlighter cannot be loaded. Do not turn a diff into a panel error.
    });
    return () => { active = false; };
  }, []);

  if (Platform.OS === "web" && webRenderer) {
    return createElement(webRenderer, props);
  }
  return <PlainCode {...props} />;
}

// Keep the native component completely effect-free. A diff can render many
// rows, and mounting one foreground/dynamic-loader effect per row makes the
// native commit phase needlessly fragile. The web-only loader is never called
// by Android or iOS.
export const HighlightedCode = Platform.OS === "web"
  ? memo(WebHighlightedCode)
  : memo(PlainCode);
