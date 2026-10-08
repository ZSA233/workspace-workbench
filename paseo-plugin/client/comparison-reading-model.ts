import { parseUnifiedPatch, pairDiffLines, type DiffLine, type DiffDisplayRow, type DiffResult } from './model.ts';
import { highlightReplacements } from './diff-layout.ts';
import type { ContextSlice } from '../shared/diff-context.ts';
export type VisibleContext = {
    oldStart: number;
    newStart: number;
    count: number;
};
export type FileGap = {
    oldStart: number;
    newStart: number;
    count: number | null;
    key: string;
};
export type FileBodyRow = {
    kind: 'code';
    key: string;
    display: DiffDisplayRow;
} | {
    kind: 'gap';
    key: string;
    gap: FileGap;
};
export function lineIdentity(line: DiffLine) { return `${line.kind}:${line.oldLine ?? ''}:${line.newLine ?? ''}`; }
export function comparisonFileRows(diff: DiffResult, mode: 'unified' | 'split', expanded: VisibleContext[] = [], slices: ContextSlice[] = []) {
    const patch = highlightReplacements(parseUnifiedPatch(diff.patch));
    if (!patch.hunks.length)
        return { parsed: patch, rows: [] as FileBodyRow[], hunks: [] as number[], displayRows: [] as DiffDisplayRow[] };
    const known = new Map<string, DiffLine>();
    for (const slice of slices)
        for (const line of slice.lines)
            known.set(lineIdentity(line), line);
    for (const hunk of patch.hunks)
        for (const line of hunk.lines)
            known.set(lineIdentity(line), line);
    // A monotonic two-sided position also orders insertions and deletions at equal positions.
    const ranked: Array<{
        line: DiffLine;
        old: number;
        next: number;
    }> = [];
    for (const hunk of patch.hunks) {
        let old = hunk.oldStart || 1, next = hunk.newStart || 1;
        for (const line of hunk.lines) {
            ranked.push({ line, old, next });
            if (line.oldLine !== null)
                old = line.oldLine + 1;
            if (line.newLine !== null)
                next = line.newLine + 1;
        }
    }
    const position = new Map(ranked.map(r => [lineIdentity(r.line), r]));
    const lines = [...known.values()].sort((a, b) => { const x = position.get(lineIdentity(a)), y = position.get(lineIdentity(b)); return ((x?.old ?? a.oldLine ?? 0) + (x?.next ?? a.newLine ?? 0)) - ((y?.old ?? b.oldLine ?? 0) + (y?.next ?? b.newLine ?? 0)) || ((a.kind === 'removed' ? 0 : 1) - (b.kind === 'removed' ? 0 : 1)); });
    const visible = new Set<number>();
    for (let i = 0; i < lines.length; i++)
        if (lines[i].kind !== 'context')
            for (let n = Math.max(0, i - 3); n <= Math.min(lines.length - 1, i + 3); n++)
                visible.add(n);
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.kind === 'context' && expanded.some(r => l.oldLine! >= r.oldStart && l.oldLine! < r.oldStart + r.count && l.newLine! >= r.newStart && l.newLine! < r.newStart + r.count))
            visible.add(i);
    }
    const output: FileBodyRow[] = [];
    let old = 1, next = 1, buffer: DiffLine[] = [], block = 0;
    const flush = () => { if (!buffer.length)
        return; const rendered: DiffDisplayRow[] = mode === 'unified' ? buffer.map(line => ({ kind: 'unified', line, hunkIndex: block, key: lineIdentity(line) })) : pairDiffLines(buffer).map(p => ({ kind: 'split', ...p, hunkIndex: block, key: `${p.left ? lineIdentity(p.left) : ''}|${p.right ? lineIdentity(p.right) : ''}` })); for (const display of rendered)
        output.push({ kind: 'code', key: display.key, display }); buffer = []; };
    const gap = (o: number, n: number, count: number | null) => { flush(); if (count === 0)
        return; const key = `gap:${o}:${n}`; output.push({ kind: 'gap', key, gap: { oldStart: o, newStart: n, count, key } }); block++; };
    for (let i = 0; i < lines.length; i++) {
        if (!visible.has(i))
            continue;
        const line = lines[i], r = position.get(lineIdentity(line));
        const o = r?.old ?? line.oldLine ?? old, n = r?.next ?? line.newLine ?? next;
        if (o > old || n > next) {
            if (o - old === n - next)
                gap(old, next, o - old);
            else
                flush();
        }
        buffer.push(line);
        if (line.oldLine !== null)
            old = line.oldLine + 1;
        if (line.newLine !== null)
            next = line.newLine + 1;
    }
    flush();
    const last = patch.hunks.at(-1), lastChanged = last?.lines.reduce((found, l, i) => l.kind !== 'context' ? i : found, -1) ?? -1;
    const atEnd = last && lastChanged >= 0 && diff.contextLines != null && last.lines.length - lastChanged - 1 < diff.contextLines;
    const totals = slices.at(-1) || (atEnd ? { oldTotal: patch.hunks.reduce((max, h) => h.lines.reduce((value, l) => Math.max(value, l.oldLine || 0), max), 0), newTotal: patch.hunks.reduce((max, h) => h.lines.reduce((value, l) => Math.max(value, l.newLine || 0), max), 0) } : undefined);
    if (!diff.truncated && !diff.binary)
        gap(old, next, totals ? Math.max(0, totals.oldTotal - old + 1) : null);
    // Navigation follows actual change runs, independently of which context is visible.
    const changeGroups = new Map<string, number>();
    let group = 0;
    for (const hunk of patch.hunks) {
        let changing = false;
        for (const line of hunk.lines) {
            if (line.kind === 'context') {
                changing = false;
                continue;
            }
            if (!changing)
                group++;
            changing = true;
            changeGroups.set(lineIdentity(line), group);
        }
    }
    const seen = new Set<number>(), hunks: number[] = [];
    for (let i = 0; i < output.length; i++) {
        const row = output[i];
        if (row.kind !== 'code')
            continue;
        const d = row.display, changed = d.kind === 'unified' ? d.line.kind !== 'context' : d.kind === 'split' && (d.left?.kind === 'removed' || d.right?.kind === 'added');
        const line = d.kind === 'unified' ? d.line : d.kind === 'split' ? d.left?.kind === 'removed' ? d.left : d.right : null;
        const id = line ? changeGroups.get(lineIdentity(line)) : undefined;
        if (changed && id !== undefined && !seen.has(id)) {
            seen.add(id);
            hunks.push(i);
        }
    }
    return { parsed: patch, rows: output, hunks, displayRows: output.flatMap(r => r.kind === 'code' ? [r.display] : []) };
}
export type DocumentRow = {
    kind: 'file' | 'status';
    path: string;
    key: string;
    message?: string;
    retry?: boolean;
} | {
    kind: 'gap';
    path: string;
    key: string;
    gap: FileGap;
} | {
    kind: 'code';
    path: string;
    key: string;
    display: DiffDisplayRow;
};
export function documentMetrics(rows: DocumentRow[], fontSize: number, measurements: Record<string, number>, headerHeight = 36) { let height = 0; const offsets: number[] = [], lengths: number[] = []; for (const row of rows) {
    offsets.push(height);
    const size = measurements[row.key] || (row.kind === 'code' ? fontSize + 8 : row.kind === 'gap' ? 34 : row.kind === 'file' ? headerHeight : 36);
    lengths.push(size);
    height += size;
} return { offsets, lengths, contentHeight: height }; }
export function documentAnchor(rows: DocumentRow[], metrics: ReturnType<typeof documentMetrics>, offset: number, covered = 0) { let index = Math.max(0, metrics.offsets.findIndex((y, i) => y + metrics.lengths[i] > offset + covered)); if (rows[index] && rows[index].kind !== 'code') {
    const path = rows[index].path;
    for (let i = index + 1; i < rows.length && rows[i].path === path; i++) {
        if (rows[i].kind === 'code') {
            index = i;
            break;
        }
    }
} const row = rows[index]; if (!row)
    return; const line = row.kind === 'code' ? (row.display.kind === 'unified' ? row.display.line : row.display.kind === 'split' ? row.display.right || row.display.left : null) : null; return { key: row.key, path: row.path, oldLine: line?.oldLine, newLine: line?.newLine, offset: offset - (metrics.offsets[index] || 0) }; }
export function anchorOffset(anchor: {
    key: string;
    path: string;
    oldLine?: number | null;
    newLine?: number | null;
    offset: number;
} | undefined, rows: DocumentRow[], metrics: ReturnType<typeof documentMetrics>) { if (!anchor)
    return 0; let index = rows.findIndex(r => r.key === anchor.key); if (index < 0 && (anchor.oldLine != null || anchor.newLine != null))
    index = rows.findIndex(r => { if (r.path !== anchor.path || r.kind !== 'code')
        return false; const lines = r.display.kind === 'unified' ? [r.display.line] : r.display.kind === 'split' ? [r.display.left, r.display.right] : []; return lines.some(l => l && (anchor.newLine != null ? l.newLine === anchor.newLine : l.oldLine === anchor.oldLine)); }); if (index < 0)
    index = rows.findIndex(r => r.path === anchor.path && r.kind === 'file'); return Math.max(0, (metrics.offsets[Math.max(0, index)] || 0) + Math.min(anchor.offset, metrics.lengths[Math.max(0, index)] || 0)); }
export function mergeVisibleContexts(ranges: VisibleContext[], next: VisibleContext) {
    const sorted = [...ranges, next].sort((a, b) => (a.newStart - a.oldStart) - (b.newStart - b.oldStart) || a.oldStart - b.oldStart), merged: VisibleContext[] = [];
    for (const range of sorted) {
        const prior = merged.at(-1);
        if (prior && prior.newStart - prior.oldStart === range.newStart - range.oldStart && prior.oldStart + prior.count >= range.oldStart)
            prior.count = Math.max(prior.oldStart + prior.count, range.oldStart + range.count) - prior.oldStart;
        else
            merged.push({ ...range });
    }
    return merged;
}
