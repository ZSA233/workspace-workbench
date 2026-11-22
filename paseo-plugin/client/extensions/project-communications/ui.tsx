import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Keyboard, Modal as NativeModal, Platform, Pressable, Text, View, useWindowDimensions, type ViewStyle } from 'react-native';
import type { PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { Icon, TextInput } from '../../native-components';
import { observerAccent, surfaceLuminance } from '../../theme';
import type { Category } from '../../../shared/extensions/project-communications/shared';

export type Theme = PluginWorkspacePanelProps['theme'];
const ThemeContext = createContext<Theme | null>(null);
const DialogChildren = createContext<{ current: number } | null>(null);
export function useChildDialog(open: boolean) {
  const parent = useContext(DialogChildren);
  useEffect(() => {
    if (!open || !parent) return;
    parent.current += 1;
    return () => { parent.current -= 1; };
  }, [open, parent]);
}
export function CommunicationsTheme({ theme, children }: { theme: Theme; children: ReactNode }) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}
export function useColors() {
  const theme = useContext(ThemeContext)!;
  return { ...theme.colors, surface1: theme.colors.surface0, accent: observerAccent(theme), accentForeground: (surfaceLuminance(theme.colors.surface0) ?? 1) < 0.35 ? theme.colors.surface0 : '#ffffff' };
}
export function tint(color: string, opacity = '16') { return /^#[\da-f]{6}$/i.test(color) ? color + opacity : color; }
export function useTouch() {
  return Platform.OS !== 'web' || Boolean((globalThis as any).matchMedia?.('(pointer: coarse)').matches);
}
export function Label({ children, muted = false, warning = false, large = false, strong = false, lines }: {
  children: ReactNode; muted?: boolean; warning?: boolean; large?: boolean; strong?: boolean; lines?: number;
}) {
  const c = useColors();
  return <Text selectable numberOfLines={lines} style={{ color: warning ? c.statusWarning : muted ? c.foregroundMuted : c.foreground,
    flexShrink: 1, maxWidth: '100%', fontSize: large ? 16 : muted ? 11 : 13, lineHeight: large ? 24 : muted ? 18 : 21, fontWeight: strong || large ? '600' : '400' }}>{children}</Text>;
}
export function Button({ children, onPress, disabled = false, active = false, id, variant = 'secondary', icon, label }: {
  children?: ReactNode; onPress: () => void; disabled?: boolean; active?: boolean; id?: string;
  variant?: 'secondary' | 'primary' | 'ghost' | 'link'; icon?: string; label?: string;
}) {
  const c = useColors(), touch = useTouch(), primary = variant === 'primary', plain = variant === 'link' || variant === 'ghost';
  const color = primary ? c.accentForeground : active || variant === 'link' ? c.accent : c.foreground;
  return <Pressable testID={id} accessibilityLabel={label} {...(Platform.OS === 'web' && label ? {title:label} : {})} accessibilityRole="button" accessibilityState={{ disabled, selected: active }} disabled={disabled} onPress={onPress}
    style={({ hovered, pressed }: any) => ({ minHeight: touch ? 44 : 30, minWidth: !children ? touch ? 44 : 30 : undefined,
      justifyContent: 'center', alignItems: 'center', flexDirection: 'row', gap: 6, paddingHorizontal: children ? plain ? 5 : 12 : 6, paddingVertical: 4,
      borderRadius: 5, borderWidth: plain ? 0 : 1, borderColor: primary || active ? c.accent : c.border,
      backgroundColor: primary ? c.accent : active ? tint(c.accent) : hovered || pressed ? c.surface2 : plain ? undefined : c.surface1, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 })}>
    {icon ? <Icon name={icon} size={15} color={color} /> : null}
    {children ? <Text style={{ fontSize: 12, fontWeight: primary ? '600' : '400', color }}>{children}</Text> : null}
  </Pressable>;
}
export function Choice({id,icon,label,disabled,onPress}:{id:string;icon:string;label:string;disabled:boolean;onPress():void}) {
  const c=useColors(),touch=useTouch();
  return <Pressable testID={id} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
    style={{minHeight:touch?44:36,flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:10,paddingVertical:6,
      borderWidth:1,borderColor:c.border,borderRadius:5,backgroundColor:c.surface1,opacity:disabled?0.45:1}}>
    <Icon name={icon} size={15} color={c.foregroundMuted}/><Text numberOfLines={1} style={{flex:1,minWidth:0,color:c.foreground,fontSize:12}}>{label}</Text>
    <Icon name="ChevronDown" size={13} color={c.foregroundMuted}/>
  </Pressable>;
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Category | 'neutral' | 'info' | 'warning' | 'success' }) {
  const c = useColors(), color = tone === 'bug' ? c.statusDanger : tone === 'warning' || tone === 'feedback' ? c.statusWarning
    : tone === 'success' ? c.statusSuccess : tone === 'change' || tone === 'info' ? c.accent : c.foregroundMuted;
  return <View style={{ alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12, backgroundColor: tone === 'neutral' || tone === 'requirement' || tone === 'decision' ? c.surface2 : tint(color) }}>
    <Text style={{ fontSize: 11, lineHeight: 17, color, fontWeight: '600' }}>{children}</Text>
  </View>;
}
export function Count({ value }: { value: number }) {
  const c = useColors();
  return <View style={{ minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, backgroundColor: c.statusDanger, alignItems: 'center', justifyContent: 'center' }}>
    <Text style={{ color: '#fff', fontSize: 11, lineHeight: 16 }}>{value}</Text>
  </View>;
}
export function Toggle({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  const c = useColors(), touch = useTouch();
  return <Pressable accessibilityRole="switch" accessibilityLabel={label} aria-checked={checked} accessibilityState={{ checked, disabled }} disabled={disabled} onPress={() => onChange(!checked)}
    style={{ minHeight: touch ? 44 : 32, flexDirection: 'row', alignItems: 'center', gap: 9, alignSelf: 'flex-start', opacity: disabled ? 0.45 : 1 }}>
    <View style={{ width: 35, height: 21, borderRadius: 11, backgroundColor: checked ? c.accent : c.foregroundMuted }}><View style={{ position: 'absolute', left: checked ? 16 : 2, top: 2, width: 17, height: 17, borderRadius: 9, backgroundColor: '#fff' }} /></View>
    <Label>{label}</Label>
  </Pressable>;
}
export function Row({ children, end = false }: { children: ReactNode; end?: boolean }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: end ? 'flex-end' : undefined, gap: 8 }}>{children}</View>;
}
export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const c = useColors(); return <View style={[{ padding: 12, gap: 8, borderWidth: 1, borderColor: c.border, borderRadius: 6, backgroundColor: c.surface2 }, style]}>{children}</View>;
}
export function Section({ title, children, action, collapsible = false, initiallyOpen = true }: {
  title: string; children: ReactNode; action?: ReactNode; collapsible?: boolean; initiallyOpen?: boolean;
}) {
  const c = useColors(), [expanded, setExpanded] = useState(initiallyOpen), touch = useTouch();
  return <View style={{ gap: 8, paddingVertical: 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {collapsible ? <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)}
        style={{ flex: 1, minHeight: touch ? 44 : 26, flexDirection: 'row', alignItems: 'center', gap: 7 }}><Icon name={expanded ? 'ChevronDown' : 'ChevronRight'} size={14} color={c.accent} /><Label strong>{title}</Label></Pressable>
        : <View style={{ flex: 1 }}><Label strong>{title}</Label></View>}
      {action}
    </View>
    {!collapsible || expanded ? children : null}
  </View>;
}
export function Field({ label, value, onChange, secret = false, multiline = false, placeholder, id, unit, inline = false, minHeight }: {
  label: string; value: string; onChange: (value: string) => void; secret?: boolean; multiline?: boolean; placeholder?: string; id?: string; unit?: string; inline?: boolean; minHeight?: number;
}) {
  const c = useColors(), touch = useTouch();
  return <View style={{ gap: 8, minWidth: 0, flexDirection: inline ? 'row' : 'column', alignItems: inline ? 'center' : undefined }}><View style={inline ? { width: 100 } : undefined}><Label muted={!inline}>{label}</Label></View><View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: inline ? 1 : undefined, minWidth: 0 }}>
    <TextInput testID={id} accessibilityLabel={label} value={value} onChangeText={onChange} secureTextEntry={secret} multiline={multiline}
      placeholder={placeholder} autoCapitalize="none" autoCorrect={false} style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: 12, lineHeight: 20,
        paddingHorizontal: 10, paddingVertical: 7, minHeight: minHeight ?? (multiline ? 104 : touch ? 44 : 36), borderRadius: 5, borderWidth: 1,
        borderColor: c.border, backgroundColor: c.surface1, textAlignVertical: multiline ? 'top' : 'center' }} />
    {unit ? <Label muted>{unit}</Label> : null}
  </View></View>;
}
export function Search({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  const c = useColors(), touch = useTouch();
  return <View style={{ flex: 1, minWidth: 120, flexDirection: 'row', alignItems: 'center', gap: 7, borderWidth: 1, borderColor: c.border, borderRadius: 5, paddingHorizontal: 9, backgroundColor: c.surface1 }}>
    <Icon name="Search" size={14} color={c.foregroundMuted} /><TextInput testID="communications-search" accessibilityLabel={placeholder} placeholder={placeholder}
      value={value} onChangeText={onChange} autoCapitalize="none" autoCorrect={false} style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: 12, minHeight: touch ? 44 : 32, paddingVertical: 6 }} />
    {value ? <Button variant="ghost" icon="X" label="清除搜索" onPress={() => onChange('')} /> : null}
  </View>;
}
export function Footer({ children }: { children: ReactNode }) {
  const c = useColors(); return <View style={{ paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface1 }}><Row end>{children}</Row></View>;
}

/** The host's standard modal is fixed to 520px. This bounded surface allows the
 * approved settings sidebar and two-column model form, without changing host UI. */
export function Dialog({ open = true, title, onClose, children, footer, width = 800, height = 700, id }: {
  open?: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number; height?: number; id?: string;
}) {
  const c = useColors(), window = useWindowDimensions(), [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const container = useRef<View>(null), close = useRef(onClose), childrenCount = useRef(0); close.current = onClose;
  useChildDialog(open);
  useEffect(() => {
    if (!open || Platform.OS === 'web') return;
    const show = Keyboard.addListener('keyboardDidShow', event => setKeyboardTop(event.endCoordinates.screenY));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardTop(null));
    return () => { show.remove(); hide.remove(); };
  }, [open]);
  useEffect(() => {
    if (!open || Platform.OS !== 'web') return;
    const target = (globalThis as any).document, previous = target?.activeElement;
    const focusable = () => Array.from((container.current as any)?.querySelectorAll('button, input, textarea, select, [tabindex]') || [])
      .filter((element: any) => element.tabIndex >= 0 && !element.disabled && element.getAttribute('aria-disabled') !== 'true' && element.getClientRects().length) as any[];
    const frame = (globalThis as any).requestAnimationFrame?.(() => focusable()[0]?.focus());
    const key = (event: any) => {
      if (childrenCount.current) return;
      // An attachment may open a host modal above this surface. Its own Escape
      // handler owns that key until focus returns to this dialog.
      const focusedDialog = target?.activeElement?.closest?.('[role="dialog"]');
      if (focusedDialog && focusedDialog !== container.current && !focusedDialog.contains(container.current)) return;
      if (event.key === 'Tab') {
        const items = focusable(), index = items.indexOf(target.activeElement);
        if (items.length && (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === items.length - 1)) {
          event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus();
        }
      }
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close.current(); }
    };
    target?.addEventListener('keydown', key, true);
    return () => { (globalThis as any).cancelAnimationFrame?.(frame); target?.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus?.(); };
  }, [open]);
  if (!open) return null;
  const available = Math.max(160, Math.min(window.height, keyboardTop ?? window.height) - 24);
  // Web Escape is handled above. The host can deliver a second native close
  // after a child unmounts; only native hardware-back uses this callback.
  return <NativeModal transparent visible onRequestClose={() => { if (Platform.OS !== 'web' && !childrenCount.current) onClose(); }} animationType="none"><DialogChildren.Provider value={childrenCount}>
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 12, paddingBottom: 12 + Math.max(0, window.height - (keyboardTop ?? window.height)) }}>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭浮层" onPress={() => { if (!childrenCount.current) onClose(); }} style={{ position: 'absolute', inset: 0, backgroundColor: '#0006' }} />
      <View ref={container} testID={id} role="dialog" aria-modal={true} accessibilityLabel={title} accessibilityViewIsModal
        style={{ width: Math.min(width, window.width - 24), height: Math.min(height, available), maxHeight: available, borderWidth: 1, borderColor: c.border,
          backgroundColor: c.surface1, borderRadius: 10, overflow: 'hidden', shadowColor: '#000', shadowRadius: 20, shadowOpacity: 0.2, elevation: 20 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 12, gap: 12, borderBottomWidth: 1, borderBottomColor: c.border }}>
          <View style={{ flex: 1 }}><Label strong>{title}</Label></View><Button icon="X" variant="ghost" label="关闭" onPress={onClose} />
        </View>
        <View style={{ flex: 1, minHeight: 0 }}>{children}</View>
        {footer ? <Footer>{footer}</Footer> : null}
      </View>
    </View>
  </DialogChildren.Provider></NativeModal>;
}
export const capabilityText: Record<string, string> = { pending: '待验证', verified: '已验证', unavailable: '不可用', failed: '失败' };
export const taskText: Record<string, string> = { auth: '钉钉授权', connection: '连接检测', models: '模型列表', generation: '生成测试', sync: '消息同步', analysis: '讨论分析', running: '处理中', waiting: '等待授权', complete: '完成', failed: '失败', cancelled: '已中断', queued: '排队中' };
export function dateText(time?: number) { return time ? new Date(time).toLocaleString() : '尚未同步'; }
export function shortTime(time: number) { return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }); }
export function ignoreFailure(promise: Promise<unknown>) { void promise.catch(() => undefined); }
