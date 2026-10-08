import {Platform,Pressable,StyleSheet,Text,View} from 'react-native';
import type {PluginWorkspacePanelProps,PluginAgentPanelProps} from '@getpaseo/plugin/client';
import type {DiffReading} from '../use-diff-reading';
import type {DiffHunk,DiffLine} from '../model';
import {DIFF_HUNK_ROW_HEIGHT} from '../model';
import {DIFF_CHANGE_GUTTER_STYLE} from '../diff-layout';
import {editorCodeFontFamily,HighlightedCode} from '../syntax';
import {railWidth} from '../diff-scroll-model';
import {observerAccent} from '../theme';
type FilePanelProps=PluginWorkspacePanelProps|PluginAgentPanelProps;
export function HunkRow({
  active,
  hunk,
  onPress,
  styles,
}: {
  active: boolean;
  hunk: DiffHunk;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.hunkRow, active && styles.hunkRowActive]}
    >
      <Text numberOfLines={1} style={styles.hunkText}>{hunk.header}</Text>
    </Pressable>
  );
}

export {OverviewRail} from './diff-overview';

export function UnifiedRow({
  nativeTokens,
  line,
  path,
  theme,
  styles,
}: {
  nativeTokens:DiffReading["nativeTokens"];
  line: DiffLine;
  path: string;
  theme: FilePanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const background = line.kind === "added" ? styles.addedRow : line.kind === "removed" ? styles.removedRow : styles.contextRow;
  const gutter = line.kind === "added" ? styles.addedGutter : line.kind === "removed" ? styles.removedGutter : styles.contextGutter;
  const marker = line.kind === "added" ? styles.addedMarker : line.kind === "removed" ? styles.removedMarker : styles.contextMarker;
  return (
    <View style={[styles.diffRow, background]}>
      <View style={[styles.changeGutter, gutter]} />
      <Text style={styles.lineNumber}>{line.oldLine ?? ""}</Text>
      <Text style={styles.lineNumber}>{line.newLine ?? ""}</Text>
      <Text style={[styles.diffMarker, marker]}>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</Text>
      <Text selectable testID="diff-code-unified" style={styles.codeText}>
        {Platform.OS!=='web'?<HighlightedCode code={line.content} path={path} theme={theme} style={styles.codeSyntaxText} spans={nativeTokens(line.content)} inlineChange={line.inlineChange} changeBackground={line.kind==='added'?`${theme.colors.statusSuccess}38`:`${theme.colors.statusDanger}38`}/>:line.inlineChange ? <>{line.inlineChange[0]>0?<HighlightedCode code={line.content.slice(0,line.inlineChange[0])} path={path} theme={theme} style={styles.codeSyntaxText}/>:null}<Text style={[styles.codeSyntaxText,{backgroundColor:line.kind==='added'?`${theme.colors.statusSuccess}38`:`${theme.colors.statusDanger}38`} ]}>{line.content.slice(...line.inlineChange)}</Text>{line.inlineChange[1]<line.content.length?<HighlightedCode code={line.content.slice(line.inlineChange[1])} path={path} theme={theme} style={styles.codeSyntaxText}/>:null}</> : <HighlightedCode code={line.content} path={path} theme={theme} style={styles.codeSyntaxText} />}
      </Text>
    </View>
  );
}

export function SplitRow({
  nativeTokens,
  left,
  right,
  path,
  theme,
  styles,
}: {
  nativeTokens:DiffReading["nativeTokens"];
  left: DiffLine | null;
  right: DiffLine | null;
  path: string;
  theme: FilePanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.splitRow}>
      <DiffCell nativeTokens={nativeTokens} line={left} path={path} theme={theme} styles={styles} side="left" />
      <View style={styles.splitDivider} />
      <DiffCell nativeTokens={nativeTokens} line={right} path={path} theme={theme} styles={styles} side="right" />
    </View>
  );
}

function DiffCell({
  nativeTokens,
  line,
  path,
  theme,
  styles,
  side,
}: {
  nativeTokens:DiffReading["nativeTokens"];
  line: DiffLine | null;
  path: string;
  theme: FilePanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
  side: "left" | "right";
}) {
  if (!line) return <View style={styles.emptyDiffCell} />;
  const background = line.kind === "added" ? styles.addedRow : line.kind === "removed" ? styles.removedRow : styles.contextRow;
  const gutter = line.kind === "added" ? styles.addedGutter : line.kind === "removed" ? styles.removedGutter : styles.contextGutter;
  const marker = line.kind === "added" ? styles.addedMarker : line.kind === "removed" ? styles.removedMarker : styles.contextMarker;
  return (
    <View style={[styles.diffCell, background]}>
      <View style={[styles.changeGutter, gutter]} />
      <Text style={styles.lineNumber}>{side === "left" ? line.oldLine ?? "" : line.newLine ?? ""}</Text>
      <Text style={[styles.diffMarker, marker]}>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</Text>
      <Text selectable testID={`diff-code-${side}`} style={styles.codeText}>
        {Platform.OS!=='web'?<HighlightedCode code={line.content} path={path} theme={theme} style={styles.codeSyntaxText} spans={nativeTokens(line.content)} inlineChange={line.inlineChange} changeBackground={line.kind==='added'?`${theme.colors.statusSuccess}38`:`${theme.colors.statusDanger}38`}/>:line.inlineChange ? <>{line.inlineChange[0]>0?<HighlightedCode code={line.content.slice(0,line.inlineChange[0])} path={path} theme={theme} style={styles.codeSyntaxText}/>:null}<Text style={[styles.codeSyntaxText,{backgroundColor:line.kind==='added'?`${theme.colors.statusSuccess}38`:`${theme.colors.statusDanger}38`} ]}>{line.content.slice(...line.inlineChange)}</Text>{line.inlineChange[1]<line.content.length?<HighlightedCode code={line.content.slice(line.inlineChange[1])} path={path} theme={theme} style={styles.codeSyntaxText}/>:null}</> : <HighlightedCode code={line.content} path={path} theme={theme} style={styles.codeSyntaxText} />}
      </Text>
    </View>
  );
}

export function makeStyles(theme: FilePanelProps["theme"], fontSize=14, wrap=false,railSize=railWidth(Platform.OS!=='web')) {
  const accent = observerAccent(theme);
  return StyleSheet.create({
    screen: { backgroundColor: theme.colors.surface0, flex: 1 },
    body: { flex: 1, minHeight: 0 },
    metaText: { color: theme.colors.foregroundMuted, fontSize: 10, marginTop: 2 },
    errorText: { color: theme.colors.statusDanger, fontSize: 11, paddingHorizontal: 12, paddingTop: 6 },
    emptyState: { alignItems: "center", flex: 1, justifyContent: "center", padding: 12 },
    emptyTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "700" },
    emptyText: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16, marginTop: 4 },
    diffShell: { backgroundColor: theme.colors.surface0, flex: 1, minHeight: 0 },
    diffViewport: { flex: 1, minHeight: 0, overflow: "hidden", position: "relative" },
    diffHorizontal: { flex: 1, minHeight: 0 },
    diffScrollContent: { flexGrow: 1, minHeight: "100%", minWidth: "100%", paddingRight: railSize },
    diffListViewport: { flex: 1, minHeight: 0 },
    diffListViewportSplit: { minWidth: 840 },
    diffListViewportUnified: { minWidth: 620 },
    diffList: { flex: 1, minHeight: 0, minWidth: "100%" },
    hunkRow: { alignItems: "center", backgroundColor: theme.colors.surface2, borderBottomColor: theme.colors.border, borderBottomWidth: 1, borderTopColor: theme.colors.border, borderTopWidth: 1, flexDirection: "row", height: DIFF_HUNK_ROW_HEIGHT, justifyContent: "space-between", paddingHorizontal: 10 },
    hunkRowActive: { backgroundColor: `${theme.colors.statusWarning}18`, borderLeftColor: theme.colors.statusWarning, borderLeftWidth: 2 },
    hunkText: { color: accent, flex: 1, fontFamily: "monospace", fontSize: 11 },
    warningText: { backgroundColor: theme.colors.surface2, color: theme.colors.statusWarning, fontSize: 11, paddingHorizontal: 12, paddingVertical: 6 },
    diffRow: { alignItems: "stretch", flexDirection: "row", minHeight: fontSize+8, ...(wrap?{}:{height:fontSize+8}) },
    splitRow: { alignItems: "stretch", flexDirection: "row", minHeight: fontSize+8, ...(wrap?{}:{height:fontSize+8}) },
    diffCell: { alignItems: "stretch", flexDirection: "row", minWidth: wrap ? 0 : 419, paddingVertical: 0, width: "50%" },
    emptyDiffCell: { backgroundColor: theme.colors.surface2, minWidth: wrap ? 0 : 419, width: "50%" },
    splitDivider: { backgroundColor: theme.colors.border, width: 1 },
    contextRow: { backgroundColor: theme.colors.surface0 },
    addedRow: { backgroundColor: `${theme.colors.statusSuccess}1f` },
    removedRow: { backgroundColor: `${theme.colors.statusDanger}1f` },
    changeGutter: DIFF_CHANGE_GUTTER_STYLE,
    contextGutter: { backgroundColor: "transparent" },
    addedGutter: { backgroundColor: theme.colors.statusSuccess },
    removedGutter: { backgroundColor: theme.colors.statusDanger },
    lineNumber: { backgroundColor: theme.colors.surface1, color: theme.colors.foregroundMuted, fontFamily: editorCodeFontFamily, fontSize: fontSize-1, lineHeight:fontSize+8, userSelect:"none", minWidth: 42, paddingHorizontal: 5, textAlign: "right" },
    diffMarker: { backgroundColor: theme.colors.surface1, fontFamily: editorCodeFontFamily, fontSize, lineHeight:fontSize+8, userSelect:"none", textAlign: "center", width: 18 },
    contextMarker: { color: theme.colors.foregroundMuted },
    addedMarker: { color: theme.colors.statusSuccess, fontWeight: "700" },
    removedMarker: { color: theme.colors.statusDanger, fontWeight: "700" },
    codeText: { color: theme.colors.foreground, flexShrink: wrap ? 1 : 0, ...(wrap?{flex:1}:{}), fontFamily: editorCodeFontFamily, fontSize, lineHeight: fontSize+8, ...(Platform.OS === "web" ? {whiteSpace:wrap?"pre-wrap":"pre",overflowWrap:"anywhere",tabSize:4} as any : {}), paddingLeft: 8, paddingRight: 16 },
    codeSyntaxText: { color: theme.colors.foreground, flexShrink: wrap ? 1 : 0, ...(wrap?{flex:1}:{}), fontFamily: editorCodeFontFamily, fontSize, lineHeight: fontSize+8, ...(Platform.OS === "web" ? {whiteSpace:wrap?"pre-wrap":"pre",overflowWrap:"anywhere",tabSize:4} as any : {}) },
    binaryState: { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderRadius: 8, borderWidth: 1, margin: 20, padding: 16 },
    binaryTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "700" },
  });
}
