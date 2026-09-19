import {
  FlatList as NativeFlatList,
  Modal as NativeModal,
  Platform,
  ScrollView as NativeScrollView,
  Text,
  TextInput as NativeTextInput,
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
} from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";

type IconProps = { name: string; size?: number; color?: string };

// Native Paseo builds do not always ship the complete injected component set.
// Keep the web host's richer controls, but never create an element from an
// undefined native export.
export function Icon({ name, size = 16, color }: IconProps) {
  if (Platform.OS === "web" && hostIcon) {
    const HostIcon = hostIcon;
    return <HostIcon name={name} size={size} color={color} />;
  }
  const glyph = name === "ChevronDown" || name === "ChevronUp"
    ? "⌄"
    : name === "ChevronRight"
      ? "›"
      : name === "CircleX"
        ? "×"
        : name === "Lock"
          ? "▣"
          : "•";
  return <Text style={{ color, fontSize: size, lineHeight: size }}>{glyph}</Text>;
}

export const ScrollView = hostScrollView || NativeScrollView;
export const FlatList = hostFlatList || NativeFlatList;
export const TextInput = hostTextInput || NativeTextInput;

function NativeModalCompat({ open, onOpenChange, title, children }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  children: ReactNode;
}) {
  return (
    <NativeModal transparent visible={open} onRequestClose={() => onOpenChange(false)}>
      <View style={{ flex: 1, justifyContent: "center", padding: 16 }}>
        <View style={{ maxHeight: "90%", padding: 12, backgroundColor: "#202124", borderRadius: 8 }}>
          <Text style={{ color: "#fff", fontWeight: "700", marginBottom: 8 }}>{title}</Text>
          {children}
        </View>
      </View>
    </NativeModal>
  );
}

NativeModalCompat.Content = function Content({ children, style, contentContainerStyle }: {
  children: ReactNode;
  style?: any;
  contentContainerStyle?: any;
}) {
  return <View style={[style, contentContainerStyle]}>{children}</View>;
};

export const Modal = hostModal || NativeModalCompat;

export function useToast() {
  if (typeof hostUseToast === "function") return hostUseToast();
  return { show() {}, error() {} };
}

export async function copyText(text: string): Promise<void> {
  if (typeof hostCopyText === "function") await hostCopyText(text);
}
