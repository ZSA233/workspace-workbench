import { useRef, useMemo, useLayoutEffect, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { useDiffNotes, type DiffNotes } from './components/diff-notes';
import { useNativeSyntax } from './use-native-syntax';
import type { DiffDisplayRow, DiffResult } from './model';
import type { FileReviewSelection } from './file-review-store';
import type { PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import type { ChangeNote, NotesResult } from '../shared/change-notes';
type Entry = {
    notes: DiffNotes;
    tokens: ReturnType<typeof useNativeSyntax>;
    rows: DiffDisplayRow[];
    indexes: Map<string, number>;
    placements: ReturnType<DiffNotes['positions']>;
};
export function createComparisonNotesRegistry() { let version = 0; const entries = new Map<string, Entry>(), listeners = new Set<() => void>(); return { entries, subscribe: (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; }, snapshot: () => version, publish() { version++; listeners.forEach(f => f()); } }; }
export type NotesRegistry = ReturnType<typeof createComparisonNotesRegistry>;
export function ComparisonFileNotes({ registry, selection, diff, rows, visible, foreground, theme, jump, reveal, openOther }: {
    registry: NotesRegistry;
    selection: FileReviewSelection;
    diff: DiffResult;
    rows: DiffDisplayRow[];
    visible: number[];
    foreground: boolean;
    theme: PluginWorkspacePanelProps['theme'];
    jump(key: string): void;
    reveal(anchor: ChangeNote['content']['anchors'][number]): void;
    openOther(anchor: ChangeNote['content']['anchors'][number], note: ChangeNote, data: NotesResult): void;
}) {
    const notes = useDiffNotes(selection, diff, foreground, theme, openOther, { revealAnchor: reveal });
    const stableVisible = useMemo(() => visible, [visible.join(',')]);
    const tokens = useNativeSyntax(rows, selection.path, foreground, stableVisible);
    const indexes = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);
    const placements = notes.positions(rows), latest = useRef(jump);
    latest.current = jump;
    useLayoutEffect(() => { registry.entries.set(selection.path, { notes, tokens, rows, indexes, placements }); registry.publish(); });
    useLayoutEffect(() => { notes.bindReading(rows, placements, index => { const row = rows[index]; if (row)
        latest.current(row.key); }); }, [rows, notes.positionsKey]);
    useLayoutEffect(() => () => { registry.entries.delete(selection.path); registry.publish(); }, [registry, selection.path]);
    return <>{notes.overlay}</>;
}
export function ComparisonNoteMarker({ registry, path, row }: {
    registry: NotesRegistry;
    path: string;
    row: DiffDisplayRow;
}) {
    useSyncExternalStore(registry.subscribe, registry.snapshot);
    const entry = registry.entries.get(path);
    if (!entry)
        return null;
    const index = entry.indexes.get(row.key) ?? -1;
    return entry.notes.renderRow(row, index, entry.placements);
}
export function ComparisonNoteToolbar({ registry, path }: {
    registry: NotesRegistry;
    path: string;
}) { useSyncExternalStore(registry.subscribe, registry.snapshot); return <View>{registry.entries.get(path)?.notes.toolbar}</View>; }
export function useComparisonTokens(registry: NotesRegistry, path: string) { useSyncExternalStore(registry.subscribe, registry.snapshot); return registry.entries.get(path)?.tokens || (() => undefined); }
