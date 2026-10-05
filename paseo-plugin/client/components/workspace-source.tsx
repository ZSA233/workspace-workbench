import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { FlatList, TextInput } from '../native-components';
import { useWorkbenchCopy } from '../i18n';
import { workspaceInstanceKey, type WorkspaceSource } from '../../shared/workspace-lineage';
import type { WorkspaceSummary } from '../model';
import { makeStyles, workspaceDisplayName } from './ui';
export function WorkspaceSourcePicker({ sources, selected, onSelect, disabled = false, emptyLabel, styles }: {
  sources: WorkspaceSummary[]; selected: WorkspaceSource | null; onSelect(value: WorkspaceSummary | null): void;
  disabled?: boolean; emptyLabel: string; styles: ReturnType<typeof makeStyles>;
}) {
  const copy = useWorkbenchCopy(), [open,setOpen] = useState(false), [search,setSearch] = useState('');
  return <View style={{ gap: 5 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={copy.sourceLabel} accessibilityState={{ expanded: open, disabled }} disabled={disabled} onPress={() => setOpen(value => !value)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{copy.sourceLabel}: {selected?.displayName || emptyLabel}</Text></Pressable>
    {open ? <View style={{ gap: 4 }}>
      <TextInput accessibilityLabel={copy.sourceSearch} placeholder={copy.sourceSearch} value={search} onChangeText={setSearch} style={styles.targetInput} />
      <Pressable accessibilityRole="button" disabled={disabled} onPress={() => { onSelect(null); setOpen(false); }} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>{emptyLabel}</Text></Pressable>
      <FlatList style={{ maxHeight: 150 }} nestedScrollEnabled keyboardShouldPersistTaps="handled" data={sources.filter(source => `${source.displayName || ''} ${source.id}`.toLowerCase().includes(search.toLowerCase()))} keyExtractor={source => workspaceInstanceKey(source)} renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityState={{ selected: selected?.instanceKey === workspaceInstanceKey(item), disabled }} disabled={disabled} onPress={() => { onSelect(item); setOpen(false); }} style={styles.layoutMenuItem}><Text numberOfLines={1} style={styles.layoutMenuItemText}>{workspaceDisplayName(item,copy)}</Text></Pressable>} />
    </View> : null}
  </View>;
}
