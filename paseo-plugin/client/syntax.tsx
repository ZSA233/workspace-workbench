import {NativeHighlightedCode} from './syntax-native';
import type {SyntaxSpan} from './native-syntax';
import { createElement, memo, useEffect, useState, type ComponentType, type ReactElement } from "react";
import { Platform, Text, type StyleProp, type TextStyle } from "react-native";

/** Native rows draw supplied bounded token ranges, never import the web highlighter. */
export type SyntaxTheme = {
  colors: {
    surface0: string;
    foreground: string;
    foregroundMuted: string;
  };
};

export type HighlightedCodeProps = {
  spans?:readonly SyntaxSpan[]|null;
  inlineChange?:readonly [number,number];
  changeBackground?:string;
  code: string;
  path: string;
  theme: SyntaxTheme;
  style?: StyleProp<TextStyle>;
};

export { editorCodeFontFamily } from "./code-font";
import { editorCodeFontFamily } from "./code-font";

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
      {code}
    </Text>
  );
}

let loadedWebRenderer:ComponentType<HighlightedCodeProps>|null=null;
let webLoad:Promise<WebSyntaxModule>|null=null;
function WebHighlightedCode(props: HighlightedCodeProps): ReactElement {
  const [webRenderer, setWebRenderer] = useState<ComponentType<HighlightedCodeProps> | null>(()=>loadedWebRenderer);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    if(loadedWebRenderer){if(!webRenderer)setWebRenderer(()=>loadedWebRenderer);return;}
    let active = true;
    void (webLoad ||= import("./syntax-web")).then((module: WebSyntaxModule) => {
      loadedWebRenderer=module.HighlightedCode;
      if (active) setWebRenderer(() => loadedWebRenderer);
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
  : NativeHighlightedCode;
