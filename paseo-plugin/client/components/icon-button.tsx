import { ActivityIndicator, Platform, Pressable, View } from "react-native";
import { Icon, useToast } from "../native-components";

export function IconButton({ label, icon, active, busy = false, color, background, onPress, disabled=false, touch=Platform.OS !== "web" }: {
  label: string; icon: string; active?: boolean; busy?: boolean; color: string; background?: string; disabled?: boolean; touch?: boolean; onPress(): void;
}) {
  const toast = useToast();
  return <View style={{ position: "relative" }}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} accessibilityState={{ selected: active, busy, disabled }}
      {...(Platform.OS === "web" && active !== undefined ? { "aria-pressed": active } : {})}
      // Browser tooltips live outside the scroll layout; an absolutely positioned
      // child here would extend a surrounding popover's scrollable content.
      {...(Platform.OS === "web" ? { title: label } : {})}
      onLongPress={() => toast.show(label)} onPress={onPress}
      hitSlop={touch?0:4} style={{ width: touch?44:28, height: touch?44:28, marginHorizontal: 0, opacity:disabled?0.4:1, alignItems: "center", justifyContent: "center", borderRadius: 4, backgroundColor: background }}>
      {busy ? <ActivityIndicator size="small" color={color} /> : <Icon name={icon} size={touch?18:16} color={color} />}
    </Pressable>
  </View>;
}
