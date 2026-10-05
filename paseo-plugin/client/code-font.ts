import { Platform } from "react-native";
export const editorCodeFontFamily = Platform.OS === "web"
  ? 'Consolas, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, "Liberation Mono", monospace'
  : Platform.OS === "ios"
    ? "Menlo"
    : "monospace";
