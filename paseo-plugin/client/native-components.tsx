import {
  FlatList as NativeFlatList,
  Modal as NativeModal,
  Platform,
  ScrollView as NativeScrollView,
  Text,
  TextInput as NativeTextInput,
  type FlatListProps,
  type ScrollViewProps,
  type TextInputProps,
  View,
} from "react-native";
import {
  copyText as hostCopyText,
  FlatList as hostFlatList,
  Icon as hostIcon,
  Modal as hostModal,
  ScrollView as hostScrollView,
  TextInput as hostTextInput,
  useToast as hostUseToast,
  type ModalComponent,
  type ModalContentProps,
  type ModalProps,
} from "@getpaseo/plugin/client/react-native";
import { createElement, type ComponentType, type ReactNode, type Ref } from "react";
import { reportNativeDiagnostic } from "./native-diagnostics";

type IconProps = { name: string; size?: number; color?: string };

type Renderable = ComponentType<any> | { $$typeof: symbol };

function isRenderable(value: unknown): value is Renderable {
  return typeof value === "function" || (typeof value === "object" && value !== null && "$$typeof" in value);
}

function renderComponent(candidate: unknown, fallback: unknown, props: unknown, children?: ReactNode): ReactNode {
  const component = isRenderable(candidate) ? candidate : isRenderable(fallback) ? fallback : null;
  if (!component) {
    reportNativeDiagnostic("component-missing", {
      candidate: componentType(candidate),
      fallback: componentType(fallback),
    });
    return null;
  }
  return children === undefined ? createElement(component as any, props as any) : createElement(component as any, props as any, children);
}

function componentType(value: unknown): string {
  if (typeof value === "function") return `function:${value.name || "anonymous"}`;
  if (value && typeof value === "object" && "$$typeof" in value) return "react-object";
  return value === undefined ? "undefined" : value === null ? "null" : typeof value;
}

function reportNativeSelection(component: string, implementation: string): void {
  if (Platform.OS === "web") return;
  reportNativeDiagnostic("native-component-selected", { component, implementation });
}

export function nativeComponentInventory(): Record<string, string> {
  return {
    hostIcon: componentType(hostIcon),
    hostModal: componentType(hostModal),
    hostModalContent: componentType((hostModal as any)?.Content),
    hostScrollView: componentType(hostScrollView),
    hostFlatList: componentType(hostFlatList),
    hostTextInput: componentType(hostTextInput),
    nativeModal: componentType(NativeModal),
    nativeScrollView: componentType(NativeScrollView),
    nativeFlatList: componentType(NativeFlatList),
    nativeTextInput: componentType(NativeTextInput),
    nativeText: componentType(Text),
    nativeView: componentType(View),
  };
}

// Native Paseo builds do not always ship the complete injected component set.
// Keep the web host's richer controls, but never create an element from an
// undefined native export.
export function Icon({ name, size = 16, color }: IconProps) {
  if (Platform.OS === "web" && isRenderable(hostIcon)) return renderComponent(hostIcon, null, { name, size, color });
  reportNativeSelection("Icon", "text-glyph");
  const glyphs: Record<string, string> = {
    ArrowLeft: "‹",
    ChevronDown: "⌄",
    ChevronRight: "›",
    ChevronUp: "⌃",
    ChevronsUpDown: "↕",
    CircleX: "⊗",
    Ellipsis: "⋯",
    FolderTree: "▦",
    GitBranch: "⑂",
    Info: "ⓘ",
    List: "☷",
    Lock: "▣",
  };
  const glyph = glyphs[name] || "·";
  return isRenderable(Text) ? createElement(Text as any, { style: { color, fontSize: size, lineHeight: size } }, glyph) : null;
}

export function ScrollView(props: ScrollViewProps) {
  // Host controls are web-oriented injections. Android/iOS must use the
  // platform renderer directly; some host implementations install DOM/event
  // effects that are not valid in a native surface.
  if (Platform.OS !== "web") reportNativeSelection("ScrollView", "react-native");
  return Platform.OS === "web"
    ? renderComponent(hostScrollView, NativeScrollView, props)
    : renderComponent(null, NativeScrollView, props);
}

export function FlatList<Item>(props: FlatListProps<Item> & { ref?: Ref<NativeFlatList<Item>> }) {
  if (Platform.OS !== "web") reportNativeSelection("FlatList", "react-native");
  return Platform.OS === "web"
    ? renderComponent(hostFlatList, NativeFlatList, props)
    : renderComponent(null, NativeFlatList, props);
}

export function TextInput(props: TextInputProps) {
  if (Platform.OS !== "web") reportNativeSelection("TextInput", "react-native");
  return Platform.OS === "web"
    ? renderComponent(hostTextInput, NativeTextInput, props)
    : renderComponent(null, NativeTextInput, props);
}

function NativeModalCompat({ open, onOpenChange, title, children }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  children: ReactNode;
}) {
  if (!isRenderable(NativeModal) || !isRenderable(View) || !isRenderable(Text)) return null;
  return (
    createElement(NativeModal as any, { transparent: true, visible: open, onRequestClose: () => onOpenChange(false) },
      createElement(View as any, { style: { flex: 1, justifyContent: "center", padding: 16 } },
        createElement(View as any, { style: { maxHeight: "90%", padding: 12, backgroundColor: "#202124", borderRadius: 8 } },
          createElement(Text as any, { style: { color: "#fff", fontWeight: "700", marginBottom: 8 } }, title),
          children
        ),
      ),
    )
  );
}

const NativeModalContent = function Content({ children, style, contentContainerStyle }: {
  children: ReactNode;
  style?: any;
  contentContainerStyle?: any;
}) {
  return isRenderable(View) ? createElement(View as any, { style: [style, contentContainerStyle] }, children) : null;
};

const NativeModalComponent = Object.assign(NativeModalCompat, { Content: NativeModalContent });

export const Modal = Object.assign(function Modal(props: ModalProps) {
  const hostContent = isRenderable((hostModal as any)?.Content) ? (hostModal as any).Content : null;
  if (Platform.OS !== "web") reportNativeSelection("Modal", "react-native");
  const component = Platform.OS === "web" && isRenderable(hostModal) && hostContent ? hostModal : NativeModalComponent;
  return createElement(component as any, props);
}, {
  Content(props: ModalContentProps) {
    const hostContent = isRenderable((hostModal as any)?.Content) ? (hostModal as any).Content : null;
    return Platform.OS === "web" && hostContent ? createElement(hostContent as any, props) : createElement(NativeModalContent, props);
  },
}) as ModalComponent;

export function useToast() {
  if (typeof hostUseToast === "function") return hostUseToast();
  return { show() {}, error() {} };
}

export async function copyText(text: string): Promise<void> {
  if (typeof hostCopyText === "function") await hostCopyText(text);
}
