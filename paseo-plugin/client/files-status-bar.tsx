import { useState, type ReactNode } from 'react';
import { Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Modal } from './native-components';
import { GeometricIcon } from './geometric-icon';

/** File diagnostics share the existing footer; only an explicit click opens details. */
export function FilesStatusBar({ children, messages, onRefresh, zh, theme, dense }: {
  children: ReactNode;
  messages: string[];
  onRefresh(): void;
  zh: boolean;
  theme: any;
  dense: boolean;
}) {
  const c = theme.colors, { height, fontScale } = useWindowDimensions();
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set()), [details, setDetails] = useState<string[] | null>(null);
  const notices = [...new Set(messages.filter(message => message && !dismissed.has(message)))];
  const ignore = (values: string[]) => setDismissed(previous => new Set([...previous, ...values]));
  const warning = c.statusWarning || '#eabf6c';
  const label = zh ? '文件提示' : 'File notice';
  const dismiss = zh ? '忽略文件提示' : 'Dismiss file notice';
  const action = (text: string, onPress: () => void) => <Pressable accessibilityRole="button" accessibilityLabel={text} onPress={onPress} style={{ paddingHorizontal: 10, paddingVertical: 8 }}><Text style={{ color: c.foreground, fontSize: 12 }}>{text}</Text></Pressable>;

  return <>
    <View testID="files-status-bar" style={{ height: Math.max(dense ? 20 : 30, Math.ceil(14 * fontScale) + 6), flexShrink: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 7, gap: 6, overflow: 'hidden' }}>
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, lineHeight: 14, color: c.foregroundMuted, fontSize: 10 }}>{children}</Text>
      {notices.length ? <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 0 }}>
        <Pressable testID="files-notice" accessibilityRole="button" accessibilityLabel={zh ? '查看文件提示' : 'View file notice'} {...(Platform.OS === 'web' ? { title: zh ? '查看文件提示详情' : 'View file notice details' } : {})} onPress={() => setDetails(notices)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 4, alignSelf: 'stretch', justifyContent: 'center' }}>
          <GeometricIcon name="CircleAlert" size={12} color={warning}/>
          <Text numberOfLines={1} style={{ color: warning, fontSize: 10, lineHeight: 14 }}>{label}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={dismiss} {...(Platform.OS === 'web' ? { title: dismiss } : {})} onPress={() => ignore(notices)} style={{ width: dense ? 20 : 30, height: dense ? 20 : 30, alignItems: 'center', justifyContent: 'center' }}>
          <GeometricIcon name="X" size={11} color={c.foregroundMuted}/>
        </Pressable>
      </View> : null}
    </View>
    <Modal open={details !== null} title={label} onOpenChange={open => { if (!open) setDetails(null); }}>
      <Modal.Content scrollable style={{ maxHeight: height * 0.7 }}>
        <View testID="files-notice-dialog" style={{ padding: 14, gap: 12 }}>
          <Text selectable testID="files-notice-details" style={{ color: c.foreground, fontSize: 12, lineHeight: 18 }}>{details?.join('\n\n')}</Text>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            {action(zh ? '忽略' : 'Dismiss', () => { ignore(details || []); setDetails(null); })}
            {action(zh ? '刷新目录' : 'Refresh folders', () => { setDetails(null); onRefresh(); })}
          </View>
        </View>
      </Modal.Content>
    </Modal>
  </>;
}
