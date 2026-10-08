/** Versioned, internal context slices. The canonical patch/digest is never rewritten. */
export type ContextRequest = {
    oldStart: number;
    newStart: number;
    count: number;
    direction: 'forward' | 'backward';
};
export type ContextLine = {
    kind: 'context';
    oldLine: number;
    newLine: number;
    content: string;
};
export type ContextSlice = {
    lines: ContextLine[];
    oldTotal: number;
    newTotal: number;
    gap: {
        oldStart: number;
        newStart: number;
        count: number;
    };
    next: number | null;
    patchDigest: string;
};
export type ChangedRange = {
    oldStart: number;
    newStart: number;
    oldCount: number;
    newCount: number;
};
export function changedRanges(patch: string): ChangedRange[] {
    const ranges: ChangedRange[] = [];
    let old = 1, next = 1, active = false, block: ChangedRange | undefined;
    for (const line of patch.split('\n')) {
        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (header) {
            old = Number(header[1]) + (header[2] === '0' ? 1 : 0);
            next = Number(header[3]) + (header[4] === '0' ? 1 : 0);
            active = true;
            block = undefined;
            continue;
        }
        if (!active || line.startsWith('\\'))
            continue;
        if (line[0] === ' ') {
            old++;
            next++;
            block = undefined;
        }
        else if (line[0] === '+' || line[0] === '-') {
            if (!block) {
                block = { oldStart: old, newStart: next, oldCount: 0, newCount: 0 };
                ranges.push(block);
            }
            if (line[0] === '+') {
                block.newCount++;
                next++;
            }
            else {
                block.oldCount++;
                old++;
            }
        }
    }
    return ranges;
}
export function unchangedRanges(patch: string, oldTotal: number, newTotal: number): Array<{
    oldStart: number;
    newStart: number;
    count: number;
}> {
    const gaps: Array<{
        oldStart: number;
        newStart: number;
        count: number;
    }> = [];
    let old = 1, next = 1;
    for (const change of [...changedRanges(patch), { oldStart: oldTotal + 1, newStart: newTotal + 1, oldCount: 0, newCount: 0 }]) {
        const count = change.oldStart - old;
        if (count < 0 || count !== change.newStart - next)
            throw new Error('context_mapping_invalid');
        if (count)
            gaps.push({ oldStart: old, newStart: next, count });
        old = change.oldStart + change.oldCount;
        next = change.newStart + change.newCount;
    }
    return gaps;
}
