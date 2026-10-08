import {createScrollSignal} from './diff-scroll-store';
import {useDiffMeasurements} from './use-diff-measurements';
import {useDiffRailWidth} from './use-diff-rail-width';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useRpc, type PluginWorkspacePanelProps, type PluginAgentPanelProps } from '@getpaseo/plugin/client';
import { useQuery } from '@tanstack/react-query';
import { FlatList, ScrollView } from './native-components';
import { observerQuery, type ObserverResponse } from '../shared/observer';
import { projectBackendStatus } from '../shared/setup';
import { comparisonKey } from '../shared/comparison';
import type { ContextRequest, ContextSlice } from '../shared/diff-context';
import type { ChangeNote, NotesResult } from '../shared/change-notes';
import { DiffToolbar } from './components/diff-toolbar';
import { IconButton } from './components/icon-button';
import { ComparisonPopover } from './components/comparison-popover';
import { UnifiedRow, SplitRow, OverviewRail, makeStyles } from './components/diff-rendering';
import { ComparisonFileNotes, ComparisonNoteMarker, ComparisonNoteToolbar, createComparisonNotesRegistry, useComparisonTokens } from './comparison-notes-layer';
import { usePanelForeground } from './foreground-activity';
import { useDisplaySettings } from './use-display-settings';
import { useReviewModePreference } from './review-preferences';
import { useObservationVersions } from './use-observation-versions';
import { fileReviewQueryKey } from './file-review-query';
import { useComparisonBodies, type BodyJob } from './use-comparison-bodies';
import { mergeVisibleContexts, comparisonFileRows, documentMetrics, documentAnchor, documentIndex, anchorOffset, type DocumentRow, type FileGap } from './comparison-reading-model';
import { useFileReviews, useActiveFileReviewKey, selectionKey, setActiveFileReview, closeFileReview, openFileReview, getComparisonView, type FileReviewSelection } from './file-review-store';
import { parseUnifiedPatch, type ChangesResult, type DiffResult, type DiffDisplayRow, type DiffOverviewMarker } from './model';
import { observationQueryOptions, displayedObservation } from './observation-content';
import { useDiffCodeCopy } from './use-diff-code-copy';
type Props = (PluginWorkspacePanelProps | PluginAgentPanelProps) & {
    selection: FileReviewSelection;
};
type ComparisonDocument={rows:DocumentRow[];models:Map<string,ReturnType<typeof comparisonFileRows>>;diffs:Map<string,DiffResult>;slicesByPath:Map<string,ContextSlice[]>};
const EMPTY_VISIBLE:number[]=[];
const EMPTY_ROWS:DiffDisplayRow[]=[];
function result<T>(value: ObserverResponse | undefined): T | undefined { return displayedObservation(value)?.result as T | undefined; }
export function ComparisonReviewPanel(props: Props) {
    const { selection, theme } = props, host = props.workspaceId, key = selectionKey(selection), view = useRef(getComparisonView(host, key)).current;
    const activity = usePanelForeground(), foreground = activity.foreground, rpc = useRpc(observerQuery), backend = useRpc(projectBackendStatus);
    const railSize=useDiffRailWidth();
    const savedDisplay = useDisplaySettings();
    const display = { ...savedDisplay, ...view.display, update: (patch: {
            fontSize?: number;
            wrap?: boolean;
        }) => { view.display = { fontSize: display.fontSize, wrap: display.wrap, ...patch }; savedDisplay.update(patch); bump(); } };
    const c = theme.colors, [width, setWidth] = useState(0), [height, setHeight] = useState(0);
    const narrow = props.layout.compact || width > 0 && width < 900, preferred = useReviewModePreference(host, narrow), mode = narrow ? 'unified' : view.mode || preferred.mode, setMode = (next: 'unified' | 'split') => { view.mode = next; preferred.setMode(next); bump(); }, styles = useMemo(() => makeStyles(theme, display.fontSize, display.wrap,railSize), [theme, display.fontSize, display.wrap,railSize]);
    const selections = useFileReviews(host), activeKey = useActiveFileReviewKey(host), [revision, update] = useState(0), bump = () => update(n => n + 1);
    const [currentPath, setCurrentPath] = useState(view.currentPath || selection.path), [visiblePaths, setVisiblePaths] = useState<string[]>([]), [visibleKeys, setVisibleKeys] = useState<string[]>([]);
    const registry = useRef(createComparisonNotesRegistry()).current;
    const list = useRef<any>(null), horizontal = useRef<any>(null), copyRoot = useRef<any>(null), root = useRef<any>(null);
    useDiffCodeCopy(copyRoot);
    const [menu, setMenu] = useState<string | null>(null), [menuAnchor, setMenuAnchor] = useState({ x: 0, y: 0, width: 320, height: 36 });
    const programmatic = useRef(false);
    const manualScroll = () => { programmatic.current = false; for (const n of registry.entries.values())
        n.notes.onScroll(); };
    const scrollSignal=useRef(createScrollSignal()).current;
    useEffect(()=>()=>scrollSignal.dispose(),[scrollSignal]);
    const [dragging,setDragging]=useState(false),scroll = useRef(0), horizontalOffset = useRef(0);
    const heldDocument=useRef<ComparisonDocument|null>(null);
    const targetIdentity = JSON.stringify([selection.targetRequest, selection.path, selection.changeNoteRequest, selection.changeNoteId]);
    const pending = useRef<{
        path: string;
        codeKey?: string;
        hunk?: 'first' | 'last';
    } | null>(view.lastTarget === targetIdentity ? null : { path: selection.path });
    const [expandAll, setExpandAll] = useState<{
        path: string;
        fromOld: number;
        endOld: number;
    } | null>(null);
    const status = useQuery({ queryKey: ['workspace-workbench', 'file-review-backend', selection.projectConfig], queryFn: () => backend({ projectConfig: selection.projectConfig || '' }), enabled: !!selection.projectConfig, ...observationQueryOptions });
    useObservationVersions(selection.projectConfig, [selection.workspaceId], foreground);
    const capable = status.data?.readCapabilities?.protocol === 1, contextCapable = status.data?.readCapabilities?.contextProtocol === 1;
    const frozen = useMemo(() => ({ ...selection.comparison, fromRef: selection.comparison!.fromSha, toRef: selection.comparison!.toSha }), [comparisonKey(selection.comparison)]);
    const manifest = useQuery({ queryKey: ['workspace-workbench', selection.projectConfig, 'repository-compare', selection.workspaceId, selection.repoPath, 'files', frozen, selection.workspaceInstance], queryFn: () => rpc({ projectConfig: selection.projectConfig, method: 'repository.compare', params: { workspaceId: selection.workspaceId, workspaceInstance: selection.workspaceInstance, repoPath: selection.repoPath, action: 'files', comparison: frozen } }), enabled: foreground, ...observationQueryOptions });
    const statistics = useQuery({ queryKey: ['workspace-workbench', selection.projectConfig, 'repository-compare', selection.workspaceId, selection.repoPath, 'statistics', frozen, selection.workspaceInstance], queryFn: () => rpc({ projectConfig: selection.projectConfig, method: 'repository.compare', params: { workspaceId: selection.workspaceId, workspaceInstance: selection.workspaceInstance, repoPath: selection.repoPath, action: 'statistics', comparison: frozen } }), enabled: foreground && !!result<ChangesResult>(manifest.data), ...observationQueryOptions });
    const manifestData = result<ChangesResult>(manifest.data), stats = result<ChangesResult>(statistics.data);
    const files = useMemo(() => (manifestData?.files || []).slice().sort((a, b) => a.path.localeCompare(b.path)), [manifestData]);
    const statsByPath = useMemo(() => new Map(stats?.files.map(f => [f.path, f]) || []), [stats]);
    const fileSelections=useMemo(()=>new Map(files.map(f=>[f.path,{...selection,kind:'file' as const,path:f.path,oldPath:f.oldPath,status:f.status,statusLabel:f.statusLabel,changeNoteId:f.path===selection.path?selection.changeNoteId:undefined}])),[files,selection]);
    const fileSelection = (path:string):FileReviewSelection=>fileSelections.get(path)||{...selection,kind:'file',path};
    const fileJob = (path: string): BodyJob => { const s = fileSelection(path); return { id: JSON.stringify(fileReviewQueryKey(s, host)), path, selection: s, intent: path === currentPath || visiblePaths.includes(path) ? 'interactive' : 'background' }; };
    const contextJob = (path: string, context: ContextRequest): BodyJob => { const s = fileSelection(path); return { id: JSON.stringify([...fileReviewQueryKey(s, host), 'context', context]), path, selection: s, context }; };
    const demanded = useMemo(() => { const paths = [currentPath, ...visiblePaths]; for (const p of visiblePaths.length ? visiblePaths : [currentPath]) {
        const i = files.findIndex(f => f.path === p);
        if (i > 0)
            paths.push(files[i - 1].path);
        if (i >= 0 && i + 1 < files.length)
            paths.push(files[i + 1].path);
    } return [...new Set(paths)].filter(p => files.some(f => f.path === p) && !view.collapsed.has(p)); }, [files, currentPath, visiblePaths, revision]);
    const jobs = demanded.flatMap(path => [fileJob(path), ...((path === currentPath || visiblePaths.includes(path) ? view.contexts[path] || [] : []) as ContextRequest[]).map(ctx => contextJob(path, ctx))]);
    const bodies = useComparisonBodies(jobs, host, (method, params) => rpc({ projectConfig: selection.projectConfig, method, params }), foreground && !!status.data, capable, new Set(selections.filter(s => s.kind !== 'comparison').map(s => JSON.stringify(fileReviewQueryKey(s, host)))));
    const cache = useRef(new Map<string, {
        diff: DiffResult;
        expanded: unknown;
        slices: ContextSlice[];
        mode: string;
        model: ReturnType<typeof comparisonFileRows>;
    }>()).current;
    const cachedDocumentRows=useRef(new WeakMap<object,DocumentRow[]>()).current;
    const document=useMemo(()=>{
    if(dragging&&heldDocument.current)return heldDocument.current;
    const rows: DocumentRow[] = [], models = new Map<string, ReturnType<typeof comparisonFileRows>>(), diffs = new Map<string, DiffResult>(), slicesByPath = new Map<string, ContextSlice[]>();
    for (const file of files) {
        rows.push({ kind: 'file', path: file.path, key: `file:${file.path}` });
        if (view.collapsed.has(file.path))
            continue;
        const response = bodies.response(fileJob(file.path)), diff = result<DiffResult>(response);
        if (!diff?.patch && diff?.patch !== '') {
            cache.delete(file.path);
            rows.push({ kind: 'status', path: file.path, key: `status:${file.path}`, retry: response?.ok === false, message: response?.ok === false ? `${response.error?.message || '读取失败'} · 重试` : foreground ? '按需加载…' : '等待返回前台' });
            continue;
        }
        diffs.set(file.path, diff);
        if (diff.binary) {
            rows.push({ kind: 'status', path: file.path, key: `binary:${file.path}`, message: '二进制文件：不展开文本差异' });
            continue;
        }
        if (/^index .* 160000$|^(?:new file|deleted file|old|new) mode 160000$/m.test(diff.patch)) {
            rows.push({ kind: 'status', path: file.path, key: `gitlink:${file.path}`, message: '子模块引用变化，请单独查看' });
            continue;
        }
        if (diff.truncated)
            rows.push({ kind: 'status', path: file.path, key: `truncated:${file.path}`, message: '差异已截断，未展示完整内容' });
        const slices = ((view.contexts[file.path] || []) as ContextRequest[]).map(request => result<ContextSlice>(bodies.read(contextJob(file.path, request)))).filter((s): s is ContextSlice => !!s?.lines && s.patchDigest === diff.patchDigest);
        slicesByPath.set(file.path, slices);
        const expanded = view.expanded[file.path], prior = cache.get(file.path);
        let model: ReturnType<typeof comparisonFileRows>;
        if (prior && prior.diff === diff && prior.expanded === expanded && prior.mode === mode && prior.slices.length === slices.length && prior.slices.every((s, i) => s === slices[i]))
            model = prior.model;
        else {
            model = comparisonFileRows(diff, mode, expanded, slices);
            cache.set(file.path, { diff, expanded, slices, mode, model });
        }
        models.set(file.path, model);
        if (!model.parsed.hunks.length)
            rows.push({ kind: 'status', path: file.path, key: `empty:${file.path}`, message: '仅文件属性或路径变化，没有文本修改块' });
        let fileRows=cachedDocumentRows.get(model);
        if(!fileRows){fileRows=model.rows.map(row=>({...row,path:file.path,key:`${file.path}:${row.key}`}));cachedDocumentRows.set(model,fileRows);}
        for(const row of fileRows)rows.push(row);
        for (const request of (view.contexts[file.path] || []) as ContextRequest[]) {
            const r = bodies.response(contextJob(file.path, request));
            if (r?.ok === false)
                rows.push({ kind: 'status', path: file.path, key: `context-error:${file.path}:${JSON.stringify(request)}`, retry: true, message: `上下文未展开：${r.error?.message || '读取失败'} · 重试` });
        }
    }
    const value={rows,models,diffs,slicesByPath};heldDocument.current=value;return value;
    },[files,bodies.contentVersion,revision,mode,foreground,dragging]);
    const {rows,models,diffs,slicesByPath}=document;
    const { fontScale } = useWindowDimensions(), headerHeight = Math.max(Platform.OS === 'web' ? 32 : 44, Math.ceil(32 * fontScale));
    const measureGeneration = useMemo(() => ({}), [width, display.fontSize, display.wrap, mode,railSize]);
    const measurements=useDiffMeasurements(measureGeneration,dragging),measureRow=measurements.measure;
    const metrics=useMemo(()=>documentMetrics(rows,display.fontSize,measurements.values,headerHeight),[rows,display.fontSize,measurements.values,headerHeight]);
    const rowIndex=useMemo(()=>documentIndex(rows),[rows]);
    const rowsRef = useRef(rows), metricsRef = useRef(metrics);
    rowsRef.current = rows;
    metricsRef.current = metrics;
    const go = useCallback((path: string, codeKey?: string) => { view.collapsed.delete(path); view.currentPath = path; setCurrentPath(path); pending.current = { path, codeKey }; update(n => n + 1); }, [view]);
    useLayoutEffect(() => { if (view.lastTarget !== targetIdentity) {
        view.lastTarget = targetIdentity;
        go(selection.path);
    }
    else if (!restored.current && view.anchor) {
        pending.current = null;
    } }, [targetIdentity, go]);
    const previousLayout = useRef<{
        rows: DocumentRow[];
        metrics: typeof metrics;
        identity: object;
    } | null>(null), restored = useRef(false);
    useLayoutEffect(() => {
        if (!height || !rows.length || !list.current)
            return;
        const prev = previousLayout.current, identity = measureGeneration;
        let destination: number | undefined;
        if (pending.current) {
            const p = pending.current, header = rowIndex.files.get(p.path)??-1, model = models.get(p.path);
            let target = header;
            if (p.codeKey) {
                const i = rowIndex.keys.get(`${p.path}:${p.codeKey}`)??-1;
                if (i >= 0)
                    target = i;
            }
            else if (p.hunk && model?.hunks.length) {
                const h = p.hunk === 'last' ? model.hunks.at(-1)! : model.hunks[0], body = model.rows[h];
                const i = rowIndex.keys.get(`${p.path}:${body.key}`)??-1;
                if (i >= 0)
                    target = i;
            }
            if (target >= 0) {
                destination = Math.max(0, metrics.offsets[target] - (rows[target].kind === 'code' ? headerHeight : 0));
                if (visibleKeys.includes(rows[target].key) &&
                    (diffs.has(p.path) || bodies.response(fileJob(p.path))?.ok === false || view.collapsed.has(p.path)))
                    pending.current = null;
            }
        }
        else if (!restored.current && view.anchor)
            destination = anchorOffset(view.anchor, rows, metrics);
        else if (prev && (prev.identity !== identity || prev.rows !== rows || prev.metrics !== metrics))
            destination = anchorOffset(documentAnchor(prev.rows, prev.metrics, scroll.current, headerHeight), rows, metrics);
        previousLayout.current = { rows, metrics, identity };
        restored.current = true;
        if (destination !== undefined) {
            programmatic.current = true;
            scroll.current = destination;
            view.anchor = documentAnchor(rows, metrics, destination, headerHeight);
            list.current.scrollToOffset({ offset: destination, animated: false });
            scrollSignal.set(destination);
        }
    });
    useEffect(() => () => { view.anchor = documentAnchor(rowsRef.current, metricsRef.current, scroll.current, headerHeight); }, [view]);
    useLayoutEffect(() => { if (display.wrap)
        horizontal.current?.scrollTo?.({ x: 0, animated: false }); }, [display.wrap, width]);
    const navigationLookup=useRef(new Map<string,number>()),visibleSignature=useRef(''),visibilityGeneration=useRef(measureGeneration);
    if(visibilityGeneration.current!==measureGeneration){visibilityGeneration.current=measureGeneration;visibleSignature.current='';}
    const onVisible = useRef(({ viewableItems }: any) => { const items = (viewableItems || []).filter((v: any) => v.isViewable !== false && v.item).map((v: any) => v.item as DocumentRow); const paths = [...new Set<string>(items.map((r: DocumentRow) => r.path))]; setVisiblePaths(prior => JSON.stringify(prior) === JSON.stringify(paths) ? prior : paths); const keys = items.map((r: DocumentRow) => r.key); const signature=`${paths[0]}:${navigationLookup.current.get(keys[0])||0}`;if(Platform.OS!=='web'||pending.current||visibleSignature.current!==signature){visibleSignature.current=signature;setVisibleKeys(prior => JSON.stringify(prior) === JSON.stringify(keys) ? prior : keys);} if (paths[0] && !pending.current) {
        setCurrentPath(paths[0]);
        view.currentPath = paths[0];
    } for (const e of registry.entries.values())
        e.notes.onVisible(); }).current;
    function expand(path: string, gap: FileGap, all = false, backward = false, wholeFile = false) {
        if (!contextCapable) {
            setMenu(path);
            return;
        }
        const count = all ? gap.count || 200 : Math.min(20, gap.count || 20), take = Math.max(1, count);
        const start = backward && gap.count ? gap.count - Math.min(gap.count, 20) : 0;
        const range = { oldStart: gap.oldStart + start, newStart: gap.newStart + start, count: take };
        view.expanded[path] = mergeVisibleContexts(view.expanded[path] || [], range);
        // Cached patch context expands immediately; only missing source lines require a task.
        const diff = diffs.get(path), known = diff ? parseUnifiedPatch(diff.patch).hunks.flatMap(h => h.lines) : [];
        for (const slice of slicesByPath.get(path) || [])
            known.push(...slice.lines);
        const knownPositions = new Set(known.filter(l => l.kind === 'context').map(l => `${l.oldLine}:${l.newLine}`));
        let missing = -1;
        for (let i = 0; i < take; i++)
            if (!knownPositions.has(`${range.oldStart + i}:${range.newStart + i}`)) {
                missing = i;
                break;
            }
        if (missing >= 0) {
            const request: ContextRequest = { oldStart: range.oldStart + missing, newStart: range.newStart + missing, count: Math.min(200, take - missing), direction: 'forward' };
            const entries = (view.contexts[path] || []) as ContextRequest[];
            if (!entries.some(r => JSON.stringify(r) === JSON.stringify(request)))
                view.contexts[path] = [...entries, request];
        }
        if (all)
            setExpandAll(prior => prior?.path === path ? prior : { path, fromOld: wholeFile ? 1 : gap.oldStart, endOld: wholeFile || gap.count === null ? Infinity : gap.oldStart + gap.count });
        bump();
    }
    // Continue only on explicit expand-all intent, one bounded slice at a time.
    useEffect(() => { if (!expandAll || !foreground)
        return; if (currentPath !== expandAll.path && !visiblePaths.includes(expandAll.path)) {
        setExpandAll(null);
        return;
    } const path = expandAll.path, requests = (view.contexts[path] || []) as ContextRequest[]; if (requests.some(r => { const result = bodies.response(contextJob(path, r)); return !result || result.ok && !(result.result as any)?.lines; }))
        return; if (requests.some(r => bodies.response(contextJob(path, r))?.ok === false)) {
        setExpandAll(null);
        return;
    } const gap = models.get(path)?.rows.find(r => r.kind === 'gap' && r.gap.oldStart >= expandAll.fromOld && r.gap.oldStart < expandAll.endOld); if (!gap) {
        setExpandAll(null);
        return;
    } expand(path, (gap as {
        gap: FileGap;
    }).gap, true); }, [expandAll, revision, bodies.cacheVersion, foreground, currentPath, visiblePaths.join('|')]);
    function reveal(path: string, anchor: ChangeNote['content']['anchors'][number]) { const diff = diffs.get(path); if (!diff)
        return; const lines = parseUnifiedPatch(diff.patch).hunks.flatMap(h => h.lines), line = lines.find(l => (anchor.side === 'old' ? l.oldLine : l.newLine) === anchor.start); if (line?.oldLine && line.newLine) {
        view.expanded[path] = mergeVisibleContexts(view.expanded[path] || [], { oldStart: line.oldLine, newStart: line.newLine, count: Math.max(1, (anchor.end || anchor.start || 1) - (anchor.start || 1) + 1) });
        bump();
    } }
    function openOther(anchor: ChangeNote['content']['anchors'][number], note: ChangeNote, data: NotesResult) { const snapshot = data.snapshots[note.snapshotId]; if (!snapshot)
        return; if (snapshot.scope === 'compare' && comparisonKey(snapshot.comparison as any) === comparisonKey(selection.comparison)) {
        openFileReview({ ...selection, path: anchor.path, changeNoteId: note.id }, openRequest());
        return;
    } openFileReview({ ...selection, kind: snapshot.scope === 'compare' ? 'comparison' : 'file', scope: snapshot.scope as FileReviewSelection['scope'], comparison: snapshot.comparison as any, commitSha: snapshot.scope === 'commit' ? snapshot.right || undefined : undefined, path: anchor.path, changeNoteId: note.id }, openRequest()); }
    function openRequest() { return { hostWorkspaceId: host, panelId: 'agentId' in props ? 'workspace-workbench-file-agent' : 'workspace-workbench-file', ...('agentId' in props ? { agentId: props.agentId } : {}) }; }
    function solo(path: string) { openFileReview(fileSelection(path), openRequest()); }
    function toggle(path: string) { if (expandAll?.path === path)
        setExpandAll(null); view.collapsed.has(path) ? view.collapsed.delete(path) : view.collapsed.add(path); bump(); }
    function openMenu(path: string) { root.current?.measureInWindow?.((x: number, y: number, w: number) => setMenuAnchor({ x, y, width: w, height: headerHeight })); setMenu(path); }
    const model = models.get(currentPath), hunks = model?.hunks || [], currentFile = Math.max(0, files.findIndex(f => f.path === currentPath));
    const modelIndexes=useMemo(()=>new Map([...models].map(([path,model])=>[path,{body:new Map(model.rows.map((row,index)=>[`${path}:${row.key}`,index])),display:new Map(model.displayRows.map((row,index)=>[`${path}:${row.key}`,index]))}])),[models]);
    navigationLookup.current=useMemo(()=>{const out=new Map<string,number>();for(const [path,model] of models){let h=0;for(let i=0;i<model.rows.length;i++){while(h+1<model.hunks.length&&model.hunks[h+1]<=i)h++;out.set(`${path}:${model.rows[i].key}`,h);}}return out;},[models]);
    const firstVisible=visibleKeys.find(key=>modelIndexes.get(currentPath)?.body.has(key));
    const currentBodyIndex=firstVisible?modelIndexes.get(currentPath)!.body.get(firstVisible)!:-1;
    let lo=0,hi=hunks.length;while(lo<hi){const mid=(lo+hi)>>>1;if(hunks[mid]<=currentBodyIndex)lo=mid+1;else hi=mid;}
    const currentHunk=Math.max(0,lo-1);
    const navigation = { parsed: model?.parsed || { prelude: [], hunks: [] }, hunkRowIndexes: hunks, currentHunk, jumpToHunk: (index: number) => { if (index < 0 || index >= hunks.length) {
            const next = files[currentFile + (index < 0 ? -1 : 1)];
            if (next) {
                go(next.path);
                pending.current = { path: next.path, hunk: index < 0 ? 'last' : 'first' };
            }
            return;
        } const row = model?.rows[hunks[index]]; if (row)
            go(currentPath, row.key); } };
    const markers=useMemo(()=>{const markers: DiffOverviewMarker[] = [];
    rows.forEach((r, index) => { if (r.kind !== 'code')
        return; const lines = r.display.kind === 'unified' ? [r.display.line] : r.display.kind === 'split' ? [r.display.left, r.display.right].filter(Boolean) : []; const changed = lines.filter(l => l?.kind !== 'context'); if (!changed.length)
        return; const kind = changed.length > 1 ? 'modified' : changed[0]?.kind === 'added' ? 'added' : 'removed', previous = markers.at(-1); if (previous && previous.kind === kind && previous.endRow === index - 1 && rows[previous.startRow].path === r.path) {
        previous.endRow = index;
        previous.extent = (metrics.offsets[index] + metrics.lengths[index] - metrics.offsets[previous.startRow]) / Math.max(1, metrics.contentHeight);
    }
    else
        markers.push({ kind, hunkIndex: index, startRow: index, endRow: index, startLine: changed[0]?.newLine || changed[0]?.oldLine || 0, endLine: changed.at(-1)?.newLine || changed.at(-1)?.oldLine || 0, position: metrics.offsets[index] / Math.max(1, metrics.contentHeight), extent: metrics.lengths[index] / Math.max(1, metrics.contentHeight) }); });
    return markers;},[rows,metrics]);
    function header(path: string, sticky = false) { const busy = foreground && expandAll?.path === path; const f = statsByPath.get(path) || files.find(f => f.path === path); return <View testID={sticky ? 'comparison-sticky-file' : `comparison-file-${path}`} accessibilityState={{ busy }} style={{ height: headerHeight, flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface1, paddingHorizontal: 4, gap: 5 }}><IconButton label={`${view.collapsed.has(path) ? '展开' : '折叠'} ${path}`} icon={view.collapsed.has(path) ? 'ChevronRight' : 'ChevronDown'} color={c.foregroundMuted} onPress={() => toggle(path)}/><Pressable accessibilityRole="button" accessibilityLabel={`文件设置 ${path}`} onPress={() => openMenu(path)} style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={{ color: c.foreground, fontSize: 12, fontWeight: '600' }}>{path}</Text></Pressable>{busy ? <ActivityIndicator testID="comparison-context-loading" accessibilityLabel="正在展开上下文" size="small" color={c.foregroundMuted}/> : null}<Text style={{ color: c.statusSuccess, fontSize: 11 }}>+{f?.additions ?? '—'}</Text><Text style={{ color: c.statusDanger, fontSize: 11 }}>−{f?.deletions ?? '—'}</Text><IconButton label={`单独打开 ${path}`} icon="ExternalLink" color={c.foregroundMuted} onPress={() => solo(path)}/></View>; }
    const renderRow = ({ item }: {
        item: DocumentRow;
        index: number;
    }) => <View onLayout={event=>{if(display.wrap||item.kind!=='code')measureRow(item.key,event.nativeEvent.layout.height);}}>{item.kind === 'file' ? header(item.path) : item.kind === 'code' ? <ComparisonCodeRow registry={registry} path={item.path} row={item.display} theme={theme} styles={styles}/> : item.kind === 'gap' ? <View style={{ minHeight: 34, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: c.surface1 }}>{[['向前展开 20 行', true], ['向后展开 20 行', false]].filter(([, backward]) => !backward || item.gap.count !== null).map(([label, backward]) => <Pressable key={String(label)} accessibilityRole="button" onPress={() => expand(item.path, item.gap, false, Boolean(backward))}><Text style={{ color: c.foregroundMuted, fontSize: 11, paddingVertical: 8 }}>{String(label)}</Text></Pressable>)}<Pressable accessibilityRole="button" onPress={() => expand(item.path, item.gap, true)}><Text style={{ color: c.foregroundMuted, fontSize: 11, paddingVertical: 8 }}>展开此段</Text></Pressable></View> : <Pressable accessibilityRole="button" disabled={!item.retry} onPress={() => { for (const request of (view.contexts[item.path] || []) as ContextRequest[])
        if (bodies.response(contextJob(item.path, request))?.ok === false)
            bodies.retry(contextJob(item.path, request)); if (!item.key.startsWith('context-error:'))
        bodies.retry(fileJob(item.path)); bump(); }} style={{ padding: 10, minHeight: 36 }}><Text style={{ color: item.retry ? c.statusWarning : c.foregroundMuted, fontSize: 12 }}>{item.message}</Text></Pressable>}</View>;
    const noteActions=useRef({go,reveal,openOther});noteActions.current={go,reveal,openOther};
    const noteBridges=useMemo(()=>demanded.filter(path=>diffs.has(path)).map(path=>{
      const localRows=models.get(path)?.displayRows||EMPTY_ROWS;
      const visible=Platform.OS==='web'?EMPTY_VISIBLE:visibleKeys.flatMap(key=>{const index=modelIndexes.get(path)?.display.get(key);return index===undefined?[]:[index];});
      return <ComparisonFileNotes key={path} registry={registry} selection={fileSelection(path)} diff={diffs.get(path)!} rows={localRows} visible={visible} foreground={foreground} theme={theme} jump={rowKey=>noteActions.current.go(path,rowKey)} reveal={a=>noteActions.current.reveal(path,a)} openOther={(a,n,d)=>noteActions.current.openOther(a,n,d)}/>;
    }),[demanded,document,fileSelections,foreground,theme,Platform.OS==='web'?null:visibleKeys]);
    return <View ref={activity.ref} testID="workbench-diff-panel" style={styles.screen} onLayout={e => setWidth(e.nativeEvent.layout.width)}>
  <DiffToolbar selections={selections} activeKey={activeKey} selection={fileSelection(currentPath)} diff={diffs.get(currentPath) || null} reading={navigation} navigationLabel={files.length ? `${currentFile + 1}/${files.length}${hunks.length ? ` · ${currentHunk + 1}/${hunks.length}` : ''}` : undefined} extra={<ComparisonNoteToolbar registry={registry} path={currentPath}/>} onSelect={k => setActiveFileReview(host, k)} onClose={s => closeFileReview(host, selectionKey(s))} width={width} theme={theme} mode={mode} narrow={narrow} onMode={() => setMode(mode === 'split' ? 'unified' : 'split')} fontSize={display.fontSize} wrap={display.wrap} onDisplay={display.update} stale={false}/>
  <View ref={root} style={{ flex: 1, minHeight: 0 }}>
   {manifest.error || manifest.data?.ok === false ? <Pressable accessibilityRole="button" onPress={() => void manifest.refetch()}><Text style={styles.errorText}>{manifest.data?.error?.message || String(manifest.error)} · 重试</Text></Pressable> : null}
   {!manifestData ? <Text style={styles.emptyText}>正在读取固定比较的文件列表…</Text> : null}
   {manifestData && !files.length ? <Text style={styles.emptyText}>此比较没有文件变化。</Text> : null}
   <View ref={copyRoot} style={styles.diffViewport} {...(Platform.OS === 'web' ? { onWheelCapture: manualScroll, onPointerDownCapture: manualScroll, onKeyDownCapture: (event: any) => { if (['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End', ' '].includes(event.key))
            manualScroll(); } } : {})} onLayout={e => setHeight(e.nativeEvent.layout.height)}>
    <ScrollView ref={horizontal} horizontal testID="diff-horizontal-scroll" scrollEnabled={!display.wrap} contentContainerStyle={styles.diffScrollContent} style={styles.diffHorizontal} onScroll={e => { const x = e.nativeEvent.contentOffset.x; if (x !== horizontalOffset.current) {
        horizontalOffset.current = x;
        for (const n of registry.entries.values())
            n.notes.onScroll();
    } }}>
     <View style={[styles.diffListViewport, mode === 'split' ? styles.diffListViewportSplit : styles.diffListViewportUnified, display.wrap && { width: Math.max(0, width - railSize), minWidth: 0 }]}>
      <FlatList ref={list} testID="workbench-diff-lines" data={rows} keyExtractor={(r: DocumentRow) => r.key} renderItem={renderRow} initialNumToRender={48} windowSize={3} getItemLayout={display.wrap ? undefined : (_, index) => ({ index, offset: metrics.offsets[index] || 0, length: metrics.lengths[index] || 36 })} onScrollToIndexFailed={({ index }: any) => list.current?.scrollToOffset({ offset: metrics.offsets[index] || 0, animated: false })} onViewableItemsChanged={onVisible} viewabilityConfig={useRef({ itemVisiblePercentThreshold: 10 }).current} onScroll={e => { const y = e.nativeEvent.contentOffset.y; if (y !== scroll.current) {
        scroll.current = y;
        scrollSignal.set(y);
        for (const n of registry.entries.values()) {
            if (programmatic.current)
                n.notes.onVisible();
            else
                n.notes.onScroll();
        }
    } }} onScrollBeginDrag={manualScroll} scrollEventThrottle={16} showsVerticalScrollIndicator={false} style={styles.diffList}/>
     </View>
    </ScrollView>
    {currentPath && files.length ? <View style={{ position: 'absolute', left: 0, right: railSize, top: 0, zIndex: 6 }}>{header(currentPath, true)}</View> : null}
    <OverviewRail width={railSize} lineHeight={display.fontSize+8} contentHeight={metrics.contentHeight} markers={markers} scroll={scrollSignal} theme={theme} height={height} active={foreground} layoutIdentity={measureGeneration} onDragStateChange={setDragging} onInteractionStart={()=>{pending.current=null;manualScroll();}} onOffset={offset=>{scroll.current=offset;scrollSignal.set(offset);list.current?.scrollToOffset({offset,animated:false});}} onSelectRow={index=>{const row=rows[index];if(row)go(row.path,row.kind==='code'?row.display.key:undefined);}}/>

   </View>
   {noteBridges}
   {menu ? <ComparisonPopover title={menu} theme={theme} anchor={menuAnchor} onClose={() => setMenu(null)}><Pressable accessibilityRole="button" onPress={() => { solo(menu); setMenu(null); }}><Text style={{ color: c.foreground, padding: 10 }}>单独打开</Text></Pressable><Pressable accessibilityRole="button" onPress={() => { const gap = models.get(menu)?.rows.find(r => r.kind === 'gap'); if (gap?.kind === 'gap')
        expand(menu, gap.gap, true, false, true); setMenu(null); }}><Text style={{ color: c.foreground, padding: 10 }}>展开全部上下文</Text></Pressable><Pressable accessibilityRole="button" onPress={() => { view.expanded[menu] = []; view.contexts[menu] = []; setExpandAll(null); bump(); setMenu(null); }}><Text style={{ color: c.foreground, padding: 10 }}>收起上下文</Text></Pressable>{!contextCapable ? <Text style={{ color: c.statusWarning, padding: 10 }}>当前服务不支持上下文展开，请更新插件。</Text> : null}{expandAll?.path === menu ? <Pressable accessibilityRole="button" onPress={() => setExpandAll(null)}><Text style={{ color: c.foreground, padding: 10 }}>停止后续展开</Text></Pressable> : null}</ComparisonPopover> : null}
  </View>
 </View>;
}
const ComparisonCodeRow=memo(function ComparisonCodeRow({ registry, path, row, theme, styles }: {
    registry: ReturnType<typeof createComparisonNotesRegistry>;
    path: string;
    row: DiffDisplayRow;
    theme: PluginWorkspacePanelProps['theme'];
    styles: ReturnType<typeof makeStyles>;
}) { const tokens = useComparisonTokens(registry, path); return <View>{row.kind === 'unified' ? <UnifiedRow nativeTokens={tokens} line={row.line} path={path} theme={theme} styles={styles}/> : row.kind === 'split' ? <SplitRow nativeTokens={tokens} left={row.left} right={row.right} path={path} theme={theme} styles={styles}/> : null}<ComparisonNoteMarker registry={registry} path={path} row={row}/></View>; });
