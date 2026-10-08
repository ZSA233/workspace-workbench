import { Git } from './git.ts';
import { WorkbenchError, type Json } from './storage.ts';
import type { ObservationCache } from './cache.ts';
import { unchangedRanges, type ContextRequest, type ContextSlice } from '../../shared/diff-context.ts';
import { validateDiffPath } from './file-diff.ts';
export function contextRequest(value: unknown): ContextRequest {
    const p = value as ContextRequest;
    if (!p || !Number.isSafeInteger(p.oldStart) || p.oldStart < 1 || !Number.isSafeInteger(p.newStart) || p.newStart < 1 || !Number.isSafeInteger(p.count) || p.count < 1 || p.count > 200 || !['forward', 'backward'].includes(p.direction))
        throw new WorkbenchError('context_invalid', 'Context requests require positive line positions and at most 200 lines');
    return { oldStart: p.oldStart, newStart: p.newStart, count: p.count, direction: p.direction };
}
async function blob(git: Git, sha: string, path: string, limit: number, cache: ObservationCache): Promise<string[]> {
    validateDiffPath(path);
    const object = await git.text(['rev-parse', '--verify', `${sha}:${path}`]);
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(object))
        throw new WorkbenchError('context_object_missing', 'File object unavailable');
    const key = `diff-context-blob:${git.path}:${object}:${limit}`;
    const value = await cache.read(key, key, async () => {
        const type = await git.text(['cat-file', '-t', object]);
        if (type !== 'blob')
            throw new WorkbenchError('context_unsupported', 'Context is available only for text blobs');
        const size = Number(await git.text(['cat-file', '-s', object]));
        if (!Number.isFinite(size) || size > limit)
            throw new WorkbenchError('context_limit', 'File exceeds the context byte limit');
        const result = await git.run(['cat-file', 'blob', object], true, { maxBytes: limit });
        if (result.stdout.includes('\0'))
            throw new WorkbenchError('context_unsupported', 'Binary content has no line context');
        const lines = result.stdout ? result.stdout.split('\n') : [];
        if (result.stdout.endsWith('\n'))
            lines.pop();
        return { lines: lines.map(line => line.endsWith('\r') ? line.slice(0, -1) : line) };
    }, false);
    return value.lines as string[];
}
export async function readDiffContext(git: Git, patch: Json, params: Json, cache: ObservationCache, limit: number): Promise<ContextSlice> {
    if (patch.truncated || patch.binary || /^index .* 160000$|^(?:new file|deleted file|old|new) mode 160000$/m.test(patch.patch) || /^(?:old|new) mode 160000$/m.test(patch.patch))
        throw new WorkbenchError('context_unsupported', 'Incomplete, binary and Gitlink patches do not support context expansion');
    const request = contextRequest(params.context), oldPath = patch.oldPath || params.oldPath || params.path;
    const oldMissing = /^new file mode /m.test(patch.patch), newMissing = /^deleted file mode /m.test(patch.patch);
    const old = oldMissing ? [] : await blob(git, patch.left, oldPath, limit, cache);
    const next = newMissing ? [] : await blob(git, patch.right, params.path, limit, cache);
    let gaps;
    try {
        gaps = unchangedRanges(patch.patch, old.length, next.length);
    }
    catch {
        throw new WorkbenchError('context_mapping_invalid', 'Cannot verify unchanged line mapping');
    }
    let gap = gaps.find(g => { const offset = request.oldStart - g.oldStart; return offset === request.newStart - g.newStart && offset >= 0 && offset < g.count; });
    // The end of the canonical patch can already be EOF; an empty expansion is valid.
    if (!gap && request.oldStart === old.length + 1 && request.newStart === next.length + 1)
        return { lines: [], oldTotal: old.length, newTotal: next.length, gap: { oldStart: request.oldStart, newStart: request.newStart, count: 0 }, next: null, patchDigest: patch.patchDigest };
    if (!gap)
        throw new WorkbenchError('context_mapping_invalid', 'Requested lines are not an unchanged range');
    const offset = request.oldStart - gap.oldStart, start = request.direction === 'backward' ? Math.max(0, offset - request.count + 1) : offset;
    const end = request.direction === 'backward' ? offset + 1 : Math.min(gap.count, start + request.count);
    const lines: ContextSlice['lines'] = [];
    let bytes = 0;
    const max = Math.min(65536, limit);
    const indexes = Array.from({ length: end - start }, (_, i) => start + i);
    if (request.direction === 'backward')
        indexes.reverse();
    for (const i of indexes) {
        const content = old[gap.oldStart + i - 1];
        if (content !== next[gap.newStart + i - 1])
            throw new WorkbenchError('context_mapping_invalid', 'Context differs between the frozen versions');
        const line = { kind: 'context' as const, oldLine: gap.oldStart + i, newLine: gap.newStart + i, content }, size = Buffer.byteLength(JSON.stringify(line)) + 1;
        if (bytes + size > max - 1024) {
            if (!lines.length)
                throw new WorkbenchError('context_limit', 'A context line exceeds the response limit');
            break;
        }
        bytes += size;
        lines.push(line);
    }
    if (request.direction === 'backward')
        lines.reverse();
    const last = request.direction === 'backward' ? (lines[0]?.oldLine ?? gap.oldStart) - gap.oldStart - 1 : (lines.at(-1)?.oldLine ?? gap.oldStart - 1) - gap.oldStart + 1;
    return { lines, oldTotal: old.length, newTotal: next.length, gap, next: last >= 0 && last < gap.count ? last : null, patchDigest: patch.patchDigest };
}
