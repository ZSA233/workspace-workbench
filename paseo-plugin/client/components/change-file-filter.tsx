import { useContext, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import type { PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { DEFAULT_TEST_RULES, testFilePresets, validateTestRules, type NoteFilter, type TestFileRules } from '../../shared/change-file-filter';
import type { ChangeFileFilter } from '../use-change-file-filter';
import { useWorkbenchLocale } from '../i18n';
import { TextInput, Icon } from '../native-components';
import { observerAccent } from '../theme';
import { ComparisonPopover, type PopoverAnchor } from './comparison-popover';
import { IconButton } from './icon-button';
import { FileFilterBoundsContext } from '../file-filter-bounds';

type Props = { filter: ChangeFileFilter; theme: PluginWorkspacePanelProps['theme']; boundsRef?: { current: any }; mode?: 'tree' | 'files'; onMode?(mode: 'tree' | 'files'): void; showNotes?: boolean; showCount?: boolean };
export function ChangeFileFilterControls({ filter, theme, boundsRef, mode, onMode, showNotes = true, showCount = true }: Props) {
  const zh = useWorkbenchLocale() === 'zh-CN', text = (cn: string, en: string) => zh ? cn : en;
  const touch = Platform.OS !== 'web' || Boolean((globalThis as any).matchMedia?.('(pointer: coarse)').matches), c = theme.colors, accent = observerAccent(theme);
  const root = useRef<any>(null), notesSection = useRef<any>(null), includeInput = useRef<any>(null);
  const panelBounds=useContext(FileFilterBoundsContext)||boundsRef;
  const [page, setPage] = useState<'filters' | 'rules' | null>(null), [notesOpen, setNotesOpen] = useState(false);
  const [anchor, setAnchor] = useState<PopoverAnchor>({ x: 0, y: 0, width: 28, height: 28 });
  const [bounds, setBounds] = useState<{x:number;width:number;y?:number;height?:number}>({ x: 0, width: 340 });
  useEffect(() => { setPage(null); }, [filter.contextKey]);
  function open(notes = false) {
    setNotesOpen(notes);
    const measure = () => root.current?.measureInWindow?.((x: number, y: number, width: number, height: number) => { setAnchor({ x, y, width, height }); setPage('filters'); });
    if (panelBounds?.current?.measureInWindow) panelBounds.current.measureInWindow((x: number, y: number, width: number, height: number) => { setBounds({ x, y, width, height }); measure(); });
    else measure();
  }
  useEffect(() => { if (page !== 'filters' || touch) return; if (!notesOpen) includeInput.current?.focus?.(); else notesSection.current?.focus?.(); }, [page]);
  const normal = { color: c.foreground, fontSize: 12 }, muted = { color: c.foregroundMuted, fontSize: 11 };
  const input = { color: c.foreground, backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 4, fontSize: 12, minHeight: touch ? 44 : 30, paddingHorizontal: 8, paddingVertical: 5, flex: 1, minWidth: 0, fontFamily: 'monospace' } as const;
  const noteLabels: Record<NoteFilter, string> = zh ? { all: '全部改动', has: '有说明', none: '无说明', pending: '待确认', stale: '待更新' } : { all: 'All changes', has: 'With explanations', none: 'Without explanations', pending: 'Needs confirmation', stale: 'Needs update' };
  const choice = (key: string, label: string, selected: boolean, action: () => void) => <Pressable key={key} accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ checked: selected }} {...(Platform.OS==='web'?{'aria-checked':selected}:{})} onPress={action} style={{ flex: 1, minWidth: 0, minHeight: touch ? 44 : 28, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: selected ? accent : c.border, borderRadius: 4, backgroundColor: selected ? c.surface2 : 'transparent', paddingHorizontal: 4 }}><Text numberOfLines={1} style={[normal, selected && { color: accent }]}>{label}</Text></Pressable>;
  return <>
    <View testID="change-file-controls" style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 }}>
      {showNotes ? <IconButton touch={touch} label={text('说明筛选', 'Explanation filter')} icon="MessageSquare" active={filter.session.noteFilter !== 'all'} color={c.foregroundMuted} onPress={() => open(true)} /> : null}
      {showCount?<Text testID="change-file-count" accessibilityLabel={text(`显示 ${filter.files.length} / ${filter.total} 个文件`, `Showing ${filter.files.length} / ${filter.total} files`)} style={[muted, { fontFamily: 'monospace', marginHorizontal: 3 }]}>{filter.files.length === filter.total ? filter.total : `${filter.files.length}/${filter.total}`}</Text>:null}
      {mode && onMode ? <IconButton touch={touch} label={mode === 'tree' ? text('切换平铺列表', 'Switch to file list') : text('切换目录树', 'Switch to directory tree')} icon={mode === 'tree' ? 'FolderTree' : 'List'} color={c.foregroundMuted} onPress={() => onMode(mode === 'tree' ? 'files' : 'tree')} /> : null}
      <View ref={root}>
        <IconButton touch={touch} label={text('文件筛选', 'File filters')} icon="Ellipsis" color={c.foregroundMuted} onPress={() => open()} />
        {filter.active ? <View testID="change-file-filter-active" pointerEvents="none" style={{ position: 'absolute', right: 2, top: 3, width: 5, height: 5, borderRadius: 3, backgroundColor: accent }} /> : null}
      </View>
    </View>
    {page ? <ComparisonPopover title={page === 'rules' ? text('项目识别规则', 'Project test rules') : text('文件筛选', 'File filters')} anchor={anchor} bounds={bounds} preferredWidth={340} onClose={() => setPage(null)} theme={theme} testID="change-file-filter-popover" closeLabel={text('关闭文件筛选', 'Close file filters')}>
      {page === 'rules' ? <TestRulesEditor rules={filter.preference.rules} onChange={filter.setRules} theme={theme} onBack={() => setPage('filters')} /> : <>
        {(['include', 'exclude'] as const).map(field => <View key={field} style={{ marginTop: 5 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[normal, { width: zh ? 28 : 48 }]}>{field === 'include' ? text('包含', 'Include') : text('排除', 'Exclude')}</Text>
            <TextInput ref={field === 'include' ? includeInput : undefined} accessibilityLabel={field === 'include' ? text('包含路径', 'Include paths') : text('排除路径', 'Exclude paths')} value={filter.session[field]} placeholder={filter.session.matchMode === 'glob' ? field === 'include' ? 'internal/**' : '**/vendor/**' : field === 'include' ? text('文件名或路径', 'File name or path') : text('要排除的路径', 'Path to exclude')} placeholderTextColor={c.foregroundMuted} onChangeText={value => filter.update({ [field]: value })} autoCorrect={false} autoCapitalize="none" style={input} />
          </View>
          {filter.session.errors[field] ? <Text accessibilityRole="alert" style={{ color: c.statusWarning, fontSize: 11, marginTop: 3 }}>{text('路径模式无效；支持 *、**、?，** 需独占一级目录。保留上次有效结果。', 'Invalid pattern. Use *, ** or ?; ** must occupy a whole segment. Previous results are retained.')}</Text> : null}
        </View>)}
        <View style={{ flexDirection: 'row', gap: 6, marginVertical: 5 }}>{(['text', 'glob'] as const).map(value => choice(value, value === 'text' ? text('文字', 'Text') : text('路径模式', 'Path pattern'), filter.session.matchMode === value, () => filter.update({ matchMode: value })))}</View>
        <View style={{ borderTopWidth: 1, borderColor: c.border, paddingTop: 10, marginTop: 4, gap: 6 }}>
          <Text style={muted}>{text('测试文件', 'Test files')}</Text>
          <View style={{ flexDirection: 'row', gap: 4 }}>{(['all', 'dim', 'hide'] as const).map(value => choice(value, value === 'all' ? text('全部', 'All') : value === 'dim' ? text('弱化', 'Dim') : text('隐藏', 'Hide'), filter.preference.display === value, () => filter.setDisplay(value)))}</View>
        </View>
        {showNotes ? <View style={{ marginTop: 8 }}><Text style={muted}>{text('说明状态', 'Explanation status')}</Text><Pressable ref={notesSection} accessibilityRole="button" accessibilityLabel={text('选择说明状态', 'Choose explanation status')} accessibilityState={{ expanded: notesOpen }} onPress={() => setNotesOpen(value => !value)} style={{ minHeight: touch ? 44 : 30, borderWidth: 1, borderColor: c.border, borderRadius: 4, paddingHorizontal: 8, marginTop: 4, justifyContent: 'center' }}><Text style={normal}>{noteLabels[filter.session.noteFilter]} ⌄</Text></Pressable>{notesOpen ? <View style={{ gap: 2 }}>{(Object.keys(noteLabels) as NoteFilter[]).map(value => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={noteLabels[value]} accessibilityState={{ checked: filter.session.noteFilter === value }} {...(Platform.OS==='web'?{'aria-checked':filter.session.noteFilter===value}:{})} onPress={() => { filter.update({ noteFilter: value }); setNotesOpen(false); }} style={{ paddingVertical: touch ? 12 : 6, paddingHorizontal: 8 }}><Text style={[normal, filter.session.noteFilter === value && { color: accent }]}>{noteLabels[value]}</Text></Pressable>)}</View> : null}</View> : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderColor: c.border, marginTop: 10, paddingTop: 8 }}><Text style={normal}>{text(`匹配 ${filter.files.length} / ${filter.total} 文件`, `${filter.files.length} / ${filter.total} files match`)}</Text><Pressable accessibilityRole="button" onPress={()=>filter.reset()} style={{ paddingVertical: touch ? 10 : 4, paddingHorizontal: 4 }}><Text style={{ ...normal, color: accent }}>{text('重置', 'Reset')}</Text></Pressable></View>
        {filter.hiddenTests ? <Text style={muted}>{text(`已隐藏 ${filter.hiddenTests} 个测试文件`, `${filter.hiddenTests} test files hidden`)}</Text> : null}
        <Pressable accessibilityRole="button" onPress={() => setPage('rules')} style={{ paddingVertical: touch ? 12 : 6 }}><Text style={{ ...normal, color: accent }}>{text('项目识别规则…', 'Project test rules…')}</Text></Pressable>
      </>}
      {filter.preference.error ? <Pressable accessibilityRole="button" onPress={filter.retrySave} style={{ paddingVertical: 6 }}><Text style={{ color: c.statusWarning, fontSize: 11 }}>{filter.preference.error==='settings_read_failed'?text('设置读取失败，正在使用临时默认值。点击重新读取。','Settings could not be read. Temporary defaults are shown. Retry reading.'):filter.preference.error==='invalid_saved_rules'?text('已有规则不可用，暂用内置规则。点击恢复并保存内置规则。','Saved rules are invalid. Built-in rules are shown. Restore and save built-in rules.'):text('设置保存失败，当前显示仍有效。点击重试保存。', 'Settings could not be saved. Current view remains available. Retry saving.')}</Text></Pressable> : null}
    </ComparisonPopover> : null}
  </>;
}

function TestRulesEditor({ rules, onChange, theme, onBack }: { rules: TestFileRules; onChange(rules: TestFileRules): void; theme: Props['theme']; onBack(): void }) {
  const zh = useWorkbenchLocale() === 'zh-CN', text = (cn: string, en: string) => zh ? cn : en;
  const [draft, setDraft] = useState({ test: rules.testPatterns.join('\n'), normal: rules.normalPatterns.join('\n') }), [error, setError] = useState('');
  const c = theme.colors, accent = observerAccent(theme);
  function edit(field: 'test' | 'normal', value: string) {
    const next = { ...draft, [field]: value }; setDraft(next);
    const split = (source: string) => source.split('\n').map(s => s.trim()).filter(Boolean);
    const update = { ...rules, testPatterns: split(next.test), normalPatterns: split(next.normal) };
    try { validateTestRules(update); setError(''); onChange(update); } catch { setError(text('规则无效：每行一个路径模式，支持 *、**、?；保留上次有效规则。', 'Invalid rule. One path pattern per line; use *, ** or ?. Previous rules remain active.')); }
  }
  return <View style={{ gap: 6 }}>
    <Pressable accessibilityRole="button" onPress={onBack} style={{ paddingVertical: 6 }}><Text style={{ color: accent, fontSize: 12 }}>{text('‹ 返回文件筛选', '‹ Back to file filters')}</Text></Pressable>
    <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{text('仅保存在本机当前项目，不修改仓库。明确命名规则无法区分单元测试与集成测试。', 'Saved locally for this project. Naming rules do not distinguish unit and integration tests.')}</Text>
    {testFilePresets().map(preset => <Pressable key={preset.id} accessibilityRole="checkbox" accessibilityLabel={text(preset.labelZh, preset.label)} accessibilityState={{ checked: !rules.disabledPresets.includes(preset.id) }} {...(Platform.OS==='web'?{'aria-checked':!rules.disabledPresets.includes(preset.id)}:{})} onPress={() => onChange({ ...rules, disabledPresets: rules.disabledPresets.includes(preset.id) ? rules.disabledPresets.filter(id => id !== preset.id) : [...rules.disabledPresets, preset.id] })} style={{ minHeight:Platform.OS==='web'?28:44,flexDirection:'row',alignItems:'center',gap:8 }}><View style={{width:14,height:14,borderWidth:1,borderColor:c.border,borderRadius:2,alignItems:'center',justifyContent:'center'}}>{!rules.disabledPresets.includes(preset.id)?<Icon name="Check" size={12} color={accent}/>:null}</View><Text style={{ color: c.foreground, fontSize: 12 }}>{text(preset.labelZh, preset.label)}</Text></Pressable>)}
    {(['test', 'normal'] as const).map(field => <View key={field} style={{ gap: 4 }}><Text style={{ color: c.foreground, fontSize: 12 }}>{field === 'test' ? text('追加测试规则（每行一条）', 'Additional test patterns (one per line)') : text('始终正常显示（优先）', 'Always show normally (takes priority)')}</Text><TextInput accessibilityLabel={field === 'test' ? text('追加测试规则', 'Additional test patterns') : text('始终正常显示规则', 'Always normal patterns')} multiline numberOfLines={3} autoCorrect={false} autoCapitalize="none" value={draft[field]} onChangeText={value => edit(field, value)} style={{ color: c.foreground, fontFamily: 'monospace', fontSize: 12, borderWidth: 1, borderColor: c.border, borderRadius: 4, padding: 8, minHeight: 72, textAlignVertical: 'top' }} /></View>)}
    {error ? <Text accessibilityRole="alert" style={{ color: c.statusWarning, fontSize: 11 }}>{error}</Text> : null}
    <Pressable accessibilityRole="button" onPress={() => { setDraft({ test: '', normal: '' }); setError(''); onChange(DEFAULT_TEST_RULES); }} style={{ paddingVertical: 8 }}><Text style={{ color: accent, fontSize: 12 }}>{text('恢复内置规则', 'Restore built-in rules')}</Text></Pressable>
  </View>;
}
