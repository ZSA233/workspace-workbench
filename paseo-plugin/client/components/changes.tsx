import {ComparisonPopover,type PopoverAnchor} from './comparison-popover';
import {noteNeedsConfirmation} from '../change-notes-model';
import {useChangeNotes,noteCurrent,type NoteScope} from '../use-change-notes';
import {NoteFilterButton,type NoteFilter} from './note-filter';
import {
type PluginAgentPanelProps,
type PluginWorkspacePanelProps
} from "@getpaseo/plugin/client";
import { useEffect,useMemo,useState,useRef } from "react";
import { Platform,Pressable,Text,View,type ViewStyle } from "react-native";
import { formatCopyFrom } from "../../shared/copy";
import { changeListWindow,changeRowOffsets } from "../change-list-window.ts";
import { useWorkbenchCopy,useWorkbenchLocale } from "../i18n";
import { Icon } from "../native-components";
import { observerAccent } from "../theme";
import { IconButton } from "./icon-button";
import { ObservationIndicator } from './observation-indicator';

import {
ancestorPaths,
buildTreeRows,
defaultExpandedPaths,
type ChangeScope,
type ChangesResult,
type FileChange,
type SectionLayoutPreference,
type TreeRow
} from "../model";
import { ChangeCounts,fileColor,issueLabel,makeStyles,MiniTag,SectionDisclosureButton,SectionViewport,visibleIssues } from "./ui";

type PanelProps = PluginWorkspacePanelProps | PluginAgentPanelProps;

type ChangeTreeMode = "tree" | "files";




export function ChangedTree({
  noteScope,noteFilter,
  fill, title, hideHeader=false,
  changes,
  loading,
  lastSuccessfulAt,
  refreshing,
  error,
  stale,
  mode,
  onMode,
  scope,
  selectedCommit,
  selectedFile,
  onSelectFile,
  onLayout,
  sectionLayout,
  availableHeight,
  onSectionToggle,

  onOpenLayoutMenu,
  theme,
  styles,
}: {
  noteScope?:NoteScope;noteFilter?:NoteFilter;
  fill?: boolean; title?: string; hideHeader?: boolean;
  changes: ChangesResult | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  lastSuccessfulAt?: string | null;
  stale: boolean;
  mode: ChangeTreeMode;
  onMode: (mode: ChangeTreeMode) => void;
  scope: Exclude<ChangeScope, "commit">;
  selectedCommit: string;
  selectedFile: string;
  onSelectFile: (file: FileChange) => void;
  onLayout: (offset: number) => void;
  sectionLayout: SectionLayoutPreference;
  availableHeight: number;
  onSectionToggle: (collapsed: boolean) => void;

  onOpenLayoutMenu: () => void;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const copy = useWorkbenchCopy(),zh=useWorkbenchLocale()==='zh-CN';
  const explanations=useChangeNotes(noteScope,!!changes);
  const [noteDirectory,setNoteDirectory]=useState<{path:string;anchor:PopoverAnchor}|null>(null);
  useEffect(()=>setNoteDirectory(null),[noteScope?.workspaceId,noteScope?.repoPath,noteScope?.scope,noteScope?.commitSha,noteScope?.comparison]);
  const [localFilter,setLocalFilter]=useState<NoteFilter>('all');
  const effectiveFilter=noteFilter||localFilter;
  const byPath=useMemo(()=>{const index=new Map<string,import('../../shared/change-notes').ChangeNote[]>();for(const note of explanations.data?.notes||[])for(const path of new Set(note.content.anchors.map(a=>a.path))){const entries=index.get(path)||[];entries.push(note);index.set(path,entries);}return index;},[explanations.data]);
  const annotations=(path:string)=>byPath.get(path)||[];
  const valid=(n:import('../../shared/change-notes').ChangeNote)=>!!noteScope&&!!explanations.data&&noteCurrent(n,explanations.data,noteScope);
  const files = (changes?.files || []).filter(file=>{if(effectiveFilter==='all')return true;if(!explanations.data)return false;const notes=annotations(file.path),current=notes.filter(valid);return effectiveFilter==='has'&&current.length>0||effectiveFilter==='none'&&!current.length||effectiveFilter==='stale'&&notes.some(n=>!valid(n))||effectiveFilter==='pending'&&current.some(n=>!!explanations.data&&noteNeedsConfirmation(n,explanations.data));});
  const [scrollTop, setScrollTop] = useState(0);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(defaultExpandedPaths(files, selectedFile));
  useEffect(() => {
    setExpandedPaths((current) => new Set([...current, ...ancestorPaths(selectedFile)]));
  }, [selectedFile]);
  const rows = useMemo(() => mode === "tree"
    ? buildTreeRows(files, expandedPaths, selectedFile)
    : files.slice().sort((a, b) => a.path.localeCompare(b.path)).map((file) => ({ kind: "file" as const, file, depth: 0 })), [files, expandedPaths, selectedFile, mode]);
  const offsets = useMemo(() => changeRowOffsets(rows), [rows]);
  const windowed = Platform.OS === 'web' && rows.length > 200;
  const window = changeListWindow(offsets, scrollTop, availableHeight, windowed);

  function toggleDirectory(path: string): void {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <View
      onLayout={(event) => onLayout(event.nativeEvent.layout.y)}
      style={styles.treeSection}
    >
      {noteDirectory?<ComparisonPopover title={zh?'改动说明':'Change explanations'} anchor={noteDirectory.anchor} theme={theme} onClose={()=>setNoteDirectory(null)} testID="file-note-directory">{annotations(noteDirectory.path).map(note=><Pressable key={note.id} accessibilityRole="button" onPress={()=>{const file=changes?.files.find(f=>f.path===noteDirectory.path);setNoteDirectory(null);if(file)onSelectFile({...file,changeNoteId:note.id});}} style={{paddingVertical:8,flexDirection:'row',gap:5}}>{!valid(note)?<Icon name="CircleAlert" size={12} color={theme.colors.statusWarning}/>:null}<Text numberOfLines={2} style={{color:theme.colors.foreground,fontSize:13,flex:1}}>{note.content.title}</Text></Pressable>)}</ComparisonPopover>:null}
      {!hideHeader?<View style={styles.sectionHeader}>
        <View style={styles.sectionTitleRow}>
          <SectionDisclosureButton
            expanded={!sectionLayout.collapsed}
            label={title || (selectedCommit ? copy.text_b5d0217a47 : scope === "working" ? copy.text_b6a933155a : copy.text_f30d1e7faf)}
            onLongPress={onOpenLayoutMenu}
            onPress={() => onSectionToggle(!sectionLayout.collapsed)}
            theme={theme}
            styles={styles}
          />
          <ObservationIndicator lastSuccessfulAt={lastSuccessfulAt} hasContent={Boolean(changes)} error={error} loading={loading} refreshing={refreshing} stale={stale} theme={theme} styles={styles} />
        </View>
        <View style={styles.treeHeaderRight}>
          {noteScope?<NoteFilterButton value={localFilter} onChange={setLocalFilter} theme={theme}/>:null}
          <Text style={styles.sectionCount}>{loading || !changes ? "…" : formatCopyFrom(copy, "fileCountLabel", [files.length])}</Text>
          <IconButton label={copy.text_41e5243e2d} icon="FolderTree" active={mode === "tree"} color={mode === "tree" ? theme.colors.accentForeground : theme.colors.foregroundMuted} background={mode === "tree" ? observerAccent(theme) : undefined} onPress={() => onMode("tree")} />
          <IconButton label={copy.text_49deaf7da2} icon="List" active={mode === "files"} color={mode === "files" ? theme.colors.accentForeground : theme.colors.foregroundMuted} background={mode === "files" ? observerAccent(theme) : undefined} onPress={() => onMode("files")} />
        </View>
      </View>
      :null}
      {!sectionLayout.collapsed ? (
        <SectionViewport
          fill={fill}
          id="changes"
          windowed={windowed}
          onScroll={event => setScrollTop(event.nativeEvent.contentOffset.y)}

          availableHeight={availableHeight}
          resizable={false}

          theme={theme}
          styles={styles}
        >
          <View style={Platform.OS === "web" ? { overflowAnchor: "none" } as unknown as ViewStyle : undefined}>
          {window.before ? <View style={{ height: window.before }} /> : null}
          {rows.slice(window.start, window.end).map((row) => row.kind === "directory" ? (
            <DirectoryRow
              key={row.path}
              row={row}
              expanded={expandedPaths.has(row.path) || ancestorPaths(selectedFile).includes(row.path)}
              onPress={() => toggleDirectory(row.path)}
              theme={theme}
              styles={styles}
            />
          ) : (
            <FileChangeRow
              key={row.file.path}
              onNotes={anchor=>setNoteDirectory({path:row.file.path,anchor})}
              noteCount={annotations(row.file.path).filter(valid).length}
              notePending={annotations(row.file.path).some(n=>valid(n)&&!!explanations.data&&noteNeedsConfirmation(n,explanations.data))}
              noteStaleCount={annotations(row.file.path).filter(n=>!valid(n)).length}
              file={row.file}
              depth={row.depth}
              selected={selectedFile === row.file.path}
              onPress={() => onSelectFile(row.file)}
              theme={theme}
              styles={styles}
            />
          ))}

          {window.after ? <View style={{ height: window.after }} /> : null}
          {changes && !loading && !error && !files.length && !stale ? <Text style={styles.emptyText}>{effectiveFilter!=='all'?(explanations.error?String(explanations.error.message):!explanations.data?(zh?'说明正在读取':'Loading explanations'):(zh?'没有符合说明筛选的文件':'No files match the explanation filter')):copy.text_5ee36e41d4}</Text> : null}
          {visibleIssues(changes?.issues || []).map((issue) => <Text key={`${issue.code}-${issue.path || ""}`} style={styles.warningText}>{issueLabel(issue, copy)}</Text>)}
          </View>
        </SectionViewport>
      ) : null}
    </View>
  );
}

export function DirectoryRow({
  row,
  expanded,
  onPress,
  theme,
  styles,
}: {
  row: Extract<TreeRow, { kind: "directory" }>;
  expanded: boolean;
  onPress: () => void;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[styles.directoryRow, { paddingLeft: 4 + row.depth * 14 }]}>
      <View style={styles.folderChevron}>
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={13} color={theme.colors.foregroundMuted} />
      </View>
      <Text numberOfLines={1} style={styles.folderText}>{row.label}</Text>
      <View style={styles.directoryStats}>
        <Text style={styles.directoryFileCount}>{row.fileCount} ·</Text>
        <ChangeCounts additions={row.complete === false ? null : row.additions} deletions={row.complete === false ? null : row.deletions} styles={styles} />
      </View>
    </Pressable>
  );
}

export function FileChangeRow({
  noteCount=0,noteStaleCount=0,notePending=false,onNotes,
  file,
  depth,
  selected,
  onPress,
  theme,
  styles,
}: {
  noteCount?:number;noteStaleCount?:number;notePending?:boolean;onNotes?:(anchor:PopoverAnchor)=>void;
  file: FileChange;
  depth: number;
  selected: boolean;
  onPress: () => void;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const noteButton=useRef<any>(null);
  const label = file.oldPath ? `${file.path} ← ${file.oldPath}` : file.path;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[styles.fileRow, selected && styles.fileRowActive, { paddingLeft: 4 + depth * 14 }]}>
      <Text style={[styles.fileBadge, { color: fileColor(file.status, theme) }]}>{file.status || "M"}</Text>
      <Text numberOfLines={1} style={styles.filePath}>{label}</Text>
      {file.binary ? <MiniTag label="BIN" color={theme.colors.foregroundMuted} styles={styles} /> : null}
      {noteCount+noteStaleCount>0?<Pressable ref={noteButton} accessibilityRole="button" accessibilityLabel={`${file.path}: ${noteCount} explanations, ${noteStaleCount} need update`} onPress={event=>{event.stopPropagation();noteButton.current?.measureInWindow?.((x:number,y:number,width:number,height:number)=>onNotes?.({x,y,width,height}));}} style={{flexDirection:'row',alignItems:'center',gap:3,paddingHorizontal:4,minHeight:Platform.OS==='web'?24:44}}><Icon name={noteStaleCount?'CircleAlert':'MessageSquare'} size={13} color={noteStaleCount?theme.colors.statusWarning:theme.colors.foregroundMuted}/><Text style={{color:theme.colors.foregroundMuted,fontSize:11}}>{noteCount||noteStaleCount}</Text>{notePending?<View style={{width:5,height:5,borderRadius:3,backgroundColor:theme.colors.statusWarning}}/>:null}</Pressable>:null}
      <ChangeCounts additions={file.additions} deletions={file.deletions} styles={styles} />
    </Pressable>
  );
}
