import { useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";

export function IconButton({ label, icon, active, busy = false, color, background, onPress }: {
  label: string; icon: string; active?: boolean; busy?: boolean; color: string; background?: string; onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  const toast = useToast();
  return <View style={{ position: "relative" }}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: active, busy }}
      {...(Platform.OS === "web" && active !== undefined ? { "aria-pressed": active } : {})}
      onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} onLongPress={() => toast.show(label)} onPress={() => { setHovered(false); onPress(); }}
      hitSlop={4} style={{ width: 24, height: 24, marginHorizontal: 4, alignItems: "center", justifyContent: "center", borderRadius: 4, backgroundColor: background }}>
      {busy ? <ActivityIndicator size="small" color={color} /> : <Icon name={icon} size={15} color={color} />}
    </Pressable>
    {hovered ? <View pointerEvents="none" style={{ position: "absolute", right: 0, top: 37, minWidth: 90, padding: 5, backgroundColor: "#242830", borderRadius: 4, zIndex: 200 }}><Text style={{ color: "#fff", fontSize: 11 }}>{label}</Text></View> : null}
  </View>;
}
