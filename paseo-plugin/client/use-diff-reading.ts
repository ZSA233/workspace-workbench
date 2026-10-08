import {useDiffCodeCopy} from './use-diff-code-copy';
import {useNativeSyntax} from './use-native-syntax';
import {useMemo,useState,useRef,useEffect,useLayoutEffect,useCallback} from 'react';
import {Platform} from 'react-native';
import {parseUnifiedPatch,buildDiffDisplayRows,buildDiffOverviewMarkers,type DiffResult} from './model';
import {highlightReplacements,measuredDiffRows} from './diff-layout';
import type {ReviewMode} from './review-mode';
import type {FileReviewPosition} from './file-review-store';
const EMPTY_MEASUREMENTS:Record<string,number>={};
/** One view-scoped controller shared by the toolbar, viewport and overview rail. */
export function useDiffReading({diff,mode,fontSize,wrap,position,foreground,path}:{path:string;diff:DiffResult|null;mode:ReviewMode;fontSize:number;wrap:boolean;position:FileReviewPosition;foreground:boolean}){
  const parsed = useMemo(() => highlightReplacements(parseUnifiedPatch(diff?.patch || "")), [diff?.patch]);
  const rows = useMemo(() => buildDiffDisplayRows(parsed, mode), [mode, parsed]);
  const [visibleRows,setVisibleRows]=useState<number[]>([]);
  const nativeTokens=useNativeSyntax(rows,path,foreground,visibleRows);
  const [width,setWidth] = useState(0);
  const measurementGeneration=useMemo(()=>({}),[rows,fontSize,wrap,width]);
  const latestMeasurement=useRef(measurementGeneration);latestMeasurement.current=measurementGeneration;
  const [measurements,setMeasurements]=useState<{generation:object|null;values:Record<string,number>}>({generation:null,values:{}});
  const measured=measurements.generation===measurementGeneration?measurements.values:EMPTY_MEASUREMENTS;
  const setMeasured=useCallback((update:(current:Record<string,number>)=>Record<string,number>)=>{
    if(latestMeasurement.current!==measurementGeneration)return;
    setMeasurements(current=>{if(latestMeasurement.current!==measurementGeneration)return current;const values=current.generation===measurementGeneration?current.values:EMPTY_MEASUREMENTS;const next=update(values);return next===values&&current.generation===measurementGeneration?current:{generation:measurementGeneration,values:next};});
  },[measurementGeneration]);
  const rowMetrics = useMemo(() => measuredDiffRows(rows,fontSize,wrap?measured:EMPTY_MEASUREMENTS),[rows,wrap,fontSize,measured]);
  const overviewMarkers = useMemo(() => buildDiffOverviewMarkers(rows,rowMetrics), [rows,rowMetrics]);
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
  const horizontalRef = useRef<any>(null);
  useLayoutEffect(()=>{if(wrap)horizontalRef.current?.scrollTo?.({x:0,animated:false});},[wrap,width]);
  const copyRoot = useRef<any>(null);
  useDiffCodeCopy(copyRoot);
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
  const pendingRow=useRef<{index:number;attempts:number}|null>(null);
  const jumpToRow=useCallback((index:number,animated=true)=>{
    if(!mounted.current||index<0||index>=rows.length)return;
    position.hunk=rows[index].hunkIndex;setCurrentHunk(position.hunk);
    pendingRow.current={index,attempts:0};
    listRef.current?.scrollToIndex?.({index,animated,viewPosition:0});
  },[rows,position]);
  const onScrollToIndexFailed=useCallback(({index}:{index:number})=>{
    if(!mounted.current)return;
    pendingRow.current={index,attempts:(pendingRow.current?.attempts||0)+1};
    listRef.current?.scrollToOffset?.({offset:Math.max(0,rowMetrics.offsets[index]||0),animated:false});
  },[rowMetrics]);
  useEffect(()=>{
    const pending=pendingRow.current;if(!pending||!wrap||!measured[rows[pending.index]?.key]||pending.attempts>3)return;
    const attempt={index:pending.index,attempts:pending.attempts+1};pendingRow.current=attempt;
    listRef.current?.scrollToIndex?.({index:pending.index,animated:false,viewPosition:0});
    if(pendingRow.current===attempt)pendingRow.current=null;
  },[measured,rows,wrap]);
  const jumpToHunk = useCallback((requestedIndex: number) => {
    if (!mounted.current || !hunkRowIndexes.length) return;
    const nextIndex = ((requestedIndex % hunkRowIndexes.length) + hunkRowIndexes.length) % hunkRowIndexes.length;
    jumpToRow(hunkRowIndexes[nextIndex]);
  }, [hunkRowIndexes,jumpToRow]);

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

 return {nativeTokens,parsed,rows,setMeasured,width,setWidth,rowMetrics,overviewMarkers,hunkRowIndexes,listRef,horizontalRef,copyRoot,currentHunk,viewportHeight,scrollOffset,setScrollOffset,restoredPosition,initialOffset,contentHeight,setContentHeight,onListLayout,jumpToHunk,jumpToRow,onScrollToIndexFailed,onViewableItemsChanged,viewabilityConfig};
}
export type DiffReading=ReturnType<typeof useDiffReading>;
