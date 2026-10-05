import {useNativeSyntax} from './use-native-syntax';
import {useMemo,useState,useRef,useEffect,useLayoutEffect,useCallback} from 'react';
import {Platform} from 'react-native';
import {parseUnifiedPatch,buildDiffDisplayRows,buildDiffOverviewMarkers,type DiffResult} from './model';
import {highlightReplacements,measuredDiffRows} from './diff-layout';
import type {ReviewMode} from './review-mode';
import type {FileReviewPosition} from './file-review-store';
/** One view-scoped controller shared by the toolbar, viewport and overview rail. */
export function useDiffReading({diff,mode,fontSize,wrap,position,foreground,path}:{path:string;diff:DiffResult|null;mode:ReviewMode;fontSize:number;wrap:boolean;position:FileReviewPosition;foreground:boolean}){
  const parsed = useMemo(() => highlightReplacements(parseUnifiedPatch(diff?.patch || "")), [diff?.patch]);
  const rows = useMemo(() => buildDiffDisplayRows(parsed, mode), [mode, parsed]);
  const [visibleRows,setVisibleRows]=useState<number[]>([]);
  const nativeTokens=useNativeSyntax(rows,path,foreground,visibleRows);
  const [measured, setMeasured] = useState<Record<string,number>>({});
  const [width,setWidth] = useState(0);
  const rowMetrics = useMemo(() => measuredDiffRows(rows,fontSize,wrap?measured:{}),[rows,wrap,fontSize,measured]);
  useEffect(()=>{setMeasured({});},[wrap,fontSize,width]);
  const overviewMarkers = useMemo(() => buildDiffOverviewMarkers(rows), [rows]);
  const hunkRowIndexes = useMemo(
    () => rows.flatMap((item, index) => (item.kind === "hunk" ? [index] : [])),
    [rows],
  );
  const rowHunkIndexes = useMemo(() => {
    return rows.map((item) => item.hunkIndex);
  }, [rows]);
  const rowHunkIndexesRef = useRef(rowHunkIndexes);
  rowHunkIndexesRef.current = rowHunkIndexes;
  const listRef = useRef<any>(null);
  const copyRoot = useRef<any>(null);
  useEffect(()=>{
    if(Platform.OS!=='web') return;
    const document=(globalThis as any).document;if(!document)return;
    const copy=(event:any)=>{
      const selection=document.getSelection();if(!selection?.rangeCount||selection.isCollapsed||!copyRoot.current?.contains(selection.anchorNode))return;
      const anchor=selection.anchorNode?.nodeType===1?selection.anchorNode:selection.anchorNode?.parentElement;
      const side=anchor?.closest('[data-testid^="diff-code-"]')?.getAttribute('data-testid');if(!side)return;
      const range=selection.getRangeAt(0),parts:string[]=[];
      for(const node of copyRoot.current.querySelectorAll('[data-testid^="diff-code-"]')){
        if(node.getAttribute('data-testid')!==side||!range.intersectsNode(node))continue;
        const part=document.createRange();part.selectNodeContents(node);
        if(range.compareBoundaryPoints(0,part)>0)part.setStart(range.startContainer,range.startOffset);
        if(range.compareBoundaryPoints(2,part)<0)part.setEnd(range.endContainer,range.endOffset);
        parts.push(part.toString());
      }
      if(parts.length&&event.clipboardData){event.clipboardData.setData('text/plain',parts.join('\n'));event.preventDefault();}
    };
    document.addEventListener('copy',copy);return()=>document.removeEventListener('copy',copy);
  },[]);
  const [currentHunk, setCurrentHunk] = useState(Math.min(position.hunk, Math.max(0, hunkRowIndexes.length - 1)));
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(position.offset);
  const restoredPosition = useRef(false);
  const initialOffset = useRef({ x: 0, y: position.offset }).current;
  const [contentHeight, setContentHeight] = useState(0);
  const layoutAnchor=useRef({identity:`${wrap}:${fontSize}:${width}`,metrics:rowMetrics});
  useLayoutEffect(()=>{
    const identity=`${wrap}:${fontSize}:${width}`,previous=layoutAnchor.current;
    if(identity!==previous.identity){
      const index=Math.max(0,previous.metrics.offsets.findIndex((offset,i)=>offset+previous.metrics.lengths[i]>position.offset));
      const offset=rowMetrics.offsets[index]||0;position.offset=offset;listRef.current?.scrollToOffset({offset,animated:false});setScrollOffset(offset);
    }
    layoutAnchor.current={identity,metrics:rowMetrics};
  },[wrap,fontSize,width,rowMetrics,position]);

  useLayoutEffect(() => {
    if (!foreground) { restoredPosition.current = false; return; }
    if (restoredPosition.current || viewportHeight <= 0 || contentHeight <= 0 || !listRef.current) return;
    const offset = Math.min(position.offset, Math.max(0, contentHeight - viewportHeight));
    listRef.current.scrollToOffset({ offset, animated: false });
    restoredPosition.current = true;
    setScrollOffset(offset);
  }, [foreground, viewportHeight, contentHeight, position]);

  const onListLayout = useCallback((event: any) => {
    const nextHeight = Number(event.nativeEvent?.layout?.height) || 0;
    setViewportHeight((previous) => previous === nextHeight ? previous : nextHeight);
  }, []);

  useEffect(() => {
    setCurrentHunk(current => Math.min(current, Math.max(0, hunkRowIndexes.length - 1)));
  }, [hunkRowIndexes.length]);

  const mounted = useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const jumpToHunk = useCallback((requestedIndex: number) => {
    if (!mounted.current || !hunkRowIndexes.length) return;
    const nextIndex = ((requestedIndex % hunkRowIndexes.length) + hunkRowIndexes.length) % hunkRowIndexes.length;
    position.hunk=nextIndex;
    setCurrentHunk(nextIndex);
    listRef.current?.scrollToIndex?.({
      index: hunkRowIndexes[nextIndex],
      animated: true,
      viewPosition: 0,
    });
  }, [hunkRowIndexes,position]);

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: Array<{ index: number | null }> }) => {
    if (!mounted.current) return;
    const visibleIndexes = viewableItems
      .map((item) => item.index)
      .filter((index): index is number => typeof index === "number")
      .sort((left, right) => left - right);
    if(Platform.OS!=='web')setVisibleRows(previous=>previous.length===visibleIndexes.length&&previous.every((value,index)=>value===visibleIndexes[index])?previous:visibleIndexes);
    const firstIndex = visibleIndexes[0];
    if (firstIndex === undefined) return;
    const nextHunk = rowHunkIndexesRef.current[firstIndex] || 0;
    position.hunk = nextHunk;
    setCurrentHunk((previous) => previous === nextHunk ? previous : nextHunk);
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;

 return {nativeTokens,parsed,rows,setMeasured,width,setWidth,rowMetrics,overviewMarkers,hunkRowIndexes,listRef,copyRoot,currentHunk,viewportHeight,scrollOffset,setScrollOffset,restoredPosition,initialOffset,contentHeight,setContentHeight,onListLayout,jumpToHunk,onViewableItemsChanged,viewabilityConfig};
}
export type DiffReading=ReturnType<typeof useDiffReading>;
