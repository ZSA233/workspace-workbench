import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, Text, View, type ViewStyle } from 'react-native';
import type { PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { cacheLabel, cacheTaskActive, type CacheResource } from '../../shared/cache-management';
import { Modal, ScrollView, Icon } from '../native-components';
import { useWorkbenchLocale } from '../i18n';
import { cacheBytes, cacheRelationship, cacheUsageText } from '../cache-presentation';
import type { useCacheManagement } from '../use-cache-management';

type Theme = PluginWorkspacePanelProps['theme'];
export function CacheManagementPanel({ cache, theme }: { cache: ReturnType<typeof useCacheManagement>; theme: Theme }) {
  const locale = useWorkbenchLocale(), zh = locale === 'zh-CN', c = theme.colors;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const resources = cache.data?.resources || [], workspaces = cache.data?.workspaces || [];
  const groups = useMemo(() => {
    const values = new Map<string, { label: string; resources: CacheResource[] }>();
    for (const resource of resources) {
      const key = `${resource.scope === 'global' ? 'global' : 'project'}:${resource.providerId}`;
      const label = resource.scope === 'global' ? zh ? `全局 ${cacheLabel(resource.providerLabel, locale)} 缓存` : `Global ${cacheLabel(resource.providerLabel, locale)} caches`
        : zh ? `项目 ${cacheLabel(resource.providerLabel, locale)} 缓存` : `Project ${cacheLabel(resource.providerLabel, locale)} caches`;
      if (!values.has(key)) values.set(key, { label, resources: [] });
      values.get(key)!.resources.push(resource);
    }
    return [...values].sort(([a],[b]) => a.localeCompare(b));
  }, [resources, locale, zh]);
  const text = { color: c.foreground, fontSize: 11 };
  const muted = { color: c.foregroundMuted, fontSize: 10 };
  const row: ViewStyle = { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9, borderBottomColor: c.border, borderBottomWidth: 1 };
  const action = (label: string, onPress: () => void, disabled = false, id?: string) => <Pressable testID={id} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} accessibilityState={{ disabled }} onPress={onPress} style={{ paddingHorizontal: 7, paddingVertical: 5, borderRadius: 4, borderWidth: 1, borderColor: c.border, opacity: disabled ? 0.45 : 1 }}><Text style={text}>{label}</Text></Pressable>;
  const section = (key: string, title: string, body: ReactNode) => <View key={key}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: !collapsed.has(key) }} onPress={() => setCollapsed(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next; })} style={{ ...row, borderBottomWidth: 0, marginTop: 9 }}>
      <Icon name={collapsed.has(key) ? 'ChevronRight' : 'ChevronDown'} size={12} color={c.accent} /><Text style={{ ...text, fontSize: 12, fontWeight: '600' }}>{title}</Text>
    </Pressable>{collapsed.has(key) ? null : body}
  </View>;
  const totals = new Map<string, { label: string; bytes: number }>();
  for (const resource of resources) {
    if (resource.usage.bytes === null) continue;
    const key = `${resource.providerId}:${resource.kind}`, old = totals.get(key);
    totals.set(key, { label: `${cacheLabel(resource.providerLabel, locale)} ${cacheLabel(resource.kindLabel, locale)}`, bytes: (old?.bytes || 0) + (resource.usage.uniqueBytes ?? resource.usage.bytes) });
  }
  const active = cacheTaskActive(cache.data?.task);
  const taskLabels: Record<string, string> = zh ? { queued: '等待中', running: '更新中', paused: '已暂停', complete: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' } : {};
  return <ScrollView testID="workbench-cache-panel" style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 15, paddingBottom: 20 }}>
    <View style={[row, { backgroundColor: c.surface2, marginTop: 10, paddingHorizontal: 7, flexWrap: 'wrap' }]}>
      <Text style={{ ...text, flex: 1 }}>{totals.size ? [...totals.values()].map(value => `${value.label} ${cacheBytes(value.bytes)}`).join(' · ') : zh ? '缓存占用待统计' : 'Cache usage pending'}</Text>
      {action(zh ? '刷新' : 'Refresh', () => { void cache.scan(); }, false, 'cache-refresh')}
      {action(zh ? '全量重新统计' : 'Rescan all', () => { void cache.scan(true); }, false, 'cache-refresh-all')}
      {active && cache.data?.task?.kind === 'scan' ? action(zh ? '取消扫描' : 'Cancel scan', () => { void cache.cancelScan(); }) : null}
    </View>
    {cache.data?.workspaceTotalBytes !== null && cache.data?.workspaceTotalBytes !== undefined ? <Text style={{ ...muted, marginTop: 5 }}>Workspace {zh ? '目录合计' : 'directories'} {cacheBytes(cache.data.workspaceTotalBytes)} · {workspaces.length} Workspace</Text> : null}
    <Text style={{ ...muted, marginTop: 5 }}>{cache.data?.observedAt ? `${zh ? '最近更新' : 'Last updated'} ${new Date(cache.data.observedAt).toLocaleTimeString(locale)}` : zh ? '尚未完成统计' : 'Not measured yet'}{active ? ` · ${zh ? '后台更新中' : 'Updating in background'} ${cache.data?.task?.total ? `${cache.data.task.completed}/${cache.data.task.total}` : ''}` : ''}{cache.data?.state === 'partial' ? ` · ${zh ? '部分结果，已有数据仍可查看' : 'Partial results; previous data retained'}` : ''}</Text>
    {cache.loading ? <Text style={[muted, { marginTop: 8 }]}>{zh ? '正在读取统计快照…' : 'Loading usage snapshot…'}</Text> : null}
    {cache.error ? <Text selectable style={{ ...muted, color: c.statusWarning, marginTop: 7 }}>{cache.error}</Text> : null}
    {cache.task?.kind === 'cleanup' ? <View style={{ marginTop: 8, gap: 4 }}><Text style={text}>{zh ? '清理任务' : 'Cleanup'} · {taskLabels[cache.task.state] || cache.task.state} · {cache.task.completed}/{cache.task.total}</Text>{cache.task.error ? <Text selectable style={{ ...muted, color: c.statusWarning }}>{cache.task.error}</Text> : null}</View> : null}
    {cache.uncertain ? <View style={{ marginTop: 8, gap: 5 }}><Text style={muted}>{zh ? '清理响应未确认，尚未查到操作记录；不会自动重复清理。' : 'Cleanup response unconfirmed; no receipt found. Cleanup will not be replayed.'}</Text>{action(zh ? '核对操作状态' : 'Check operation status', () => { void cache.checkReceipt(); })}</View> : null}
    {groups.map(([key, group]) => section(key, group.label, <View>
      {group.resources.map(resource => <View key={resource.id} testID={`cache-resource-${resource.providerId}-${resource.kind}-${resource.scope}`} style={row}>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 9 }}><Text style={text}>{cacheLabel(resource.kindLabel, locale)}</Text><Text style={{ ...text, fontFamily: 'monospace' }}>{cacheUsageText(resource.usage, zh)}</Text></View>
          <Text selectable style={{ ...muted, fontFamily: 'monospace' }}>{resource.displayPath}</Text>
          {resource.usage.observedAt ? <Text style={muted}>{zh ? '统计于' : 'Measured'} {new Date(resource.usage.observedAt).toLocaleString(locale)}{resource.usage.invalidatedAt ? ` · ${zh ? '待更新' : 'Update pending'}` : ''}</Text> : null}
          {resource.scope !== 'global' ? <Text numberOfLines={1} style={muted}>{resource.scope === 'project' ? zh ? '项目共享 · 共享缓存只计一次' : 'Project shared · counted once' : resource.references.map(ref => ref.displayName).join(', ') || (zh ? '未关联 Workspace 的保留缓存' : 'Retained cache without a Workspace')}</Text> : <Text style={muted}>{zh ? '全局共享，无法准确分摊到单个 Workspace' : 'Globally shared; cannot attribute bytes to individual Workspaces'}</Text>}
          {resource.usage.error ? <Text numberOfLines={2} style={{ ...muted, color: c.statusWarning }}>{resource.usage.error}</Text> : null}
          {!resource.cleanup.available && resource.cleanup.reason ? <Text numberOfLines={2} style={muted}>{resource.cleanup.reason}</Text> : null}
        </View>
        {action(cacheLabel(resource.cleanup.label, locale), () => { void cache.inspectCleanup(resource.id); }, !resource.cleanup.available || cache.busy, `cache-clean-${resource.id}`)}
      </View>)}
    </View>))}
    {section('workspaces', zh ? 'Workspace 空间' : 'Workspace space', <View>
      <View style={[row, { backgroundColor: c.surface2, paddingHorizontal: 5 }]}><Text style={{ ...muted, flex: 1 }}>Workspace</Text><Text style={{ ...muted, width: 85 }}>{zh ? '目录占用' : 'Directory'}</Text><Text style={{ ...muted, width: 85 }}>{zh ? '缓存' : 'Caches'}</Text></View>
      {workspaces.map(workspace => {
        const linked = resources.filter(resource => workspace.resourceIds.includes(resource.id));
        return <View key={workspace.instance}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: expanded === workspace.instance }} onPress={() => setExpanded(expanded === workspace.instance ? null : workspace.instance)} style={row}>
            <Text numberOfLines={1} style={{ ...text, flex: 1 }}>{workspace.displayName}</Text><Text style={{ ...text, width: 85 }}>{cacheUsageText(workspace.usage, zh)}</Text><Text style={{ ...muted, width: 85 }}>{cacheRelationship(linked, zh)}</Text><Icon name={expanded === workspace.instance ? 'ChevronDown' : 'ChevronRight'} size={12} color={c.foregroundMuted} />
          </Pressable>
          {expanded === workspace.instance ? <View style={{ gap: 5, paddingVertical: 8, paddingLeft: 10 }}><Text selectable style={muted}>{workspace.path}</Text>{workspace.usage.observedAt ? <Text style={muted}>{zh ? '统计于' : 'Measured'} {new Date(workspace.usage.observedAt).toLocaleString(locale)}</Text> : null}{linked.map(resource => <Text selectable key={resource.id} style={muted}>{cacheLabel(resource.providerLabel, locale)} · {cacheLabel(resource.kindLabel, locale)} · {resource.scope === 'workspace' ? cacheUsageText(resource.usage, zh) : zh ? '共享引用' : 'Shared reference'}{`\n${resource.displayPath}`}</Text>)}{workspace.usage.error ? <Text style={{ ...muted, color: c.statusWarning }}>{workspace.usage.error}</Text> : null}</View> : null}
        </View>;
      })}
      {!workspaces.length ? <Text style={{ ...muted, paddingVertical: 12 }}>{zh ? '打开本页后将在后台统计 Workspace 空间。' : 'Workspace space will be measured in the background.'}</Text> : null}
    </View>)}
    <Text style={{ ...muted, marginTop: 12 }}>{zh ? '空间为磁盘分配占用估算；共享缓存仅计一次。' : 'Allocated disk usage is an estimate; shared caches are counted once.'}{cache.data?.totalsEstimated ? zh ? ' 合计来自不同时间的统计，供估算参考。' : ' Totals combine measurements from different times.' : ''}</Text>
    {cache.data?.errors.map((error, index) => <Text selectable key={index} style={{ ...muted, color: c.statusWarning }}>{error}</Text>)}
    {cache.preview ? <Modal open title={zh ? '确认清理缓存' : 'Confirm cache cleanup'} onOpenChange={open => { if (!open && !cache.busy) cache.closePreview(); }}>
      <Modal.Content scrollable style={{ maxHeight: 540 }} contentContainerStyle={{ padding: 14, gap: 12 }}>
        <Text style={text}>{cacheLabel(cache.preview.resource.providerLabel, locale)} · {cacheLabel(cache.preview.resource.kindLabel, locale)} · {cacheUsageText(cache.preview.resource.usage, zh)}</Text>
        {cache.preview.resource.paths.map(path => <Text selectable key={path} style={{ ...muted, fontFamily: 'monospace' }}>{path}</Text>)}
        <Text style={muted}>{cache.preview.resource.scope === 'global' ? zh ? '此操作影响这台主机上使用该全局缓存的项目。' : 'This affects projects using this global cache on this host.' : zh ? '此操作影响所有引用该缓存的 Workspace。' : 'This affects every Workspace referencing this cache.'}</Text>
        {cache.preview.resource.references.length ? <Text style={muted}>Workspace: {cache.preview.resource.references.map(ref => ref.displayName).join(', ')}</Text> : null}
        {cache.preview.affectedProjects.map(path => <Text selectable key={path} style={muted}>{path}</Text>)}
        <Text style={muted}>{zh ? '预计释放量以上次统计为参考；将使用工具自身的清理命令。' : 'Reclaim estimate uses the last measurement; the tool’s native cleanup command will run.'}</Text>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{action(zh ? '取消' : 'Cancel', cache.closePreview, cache.busy)}{action(cache.busy ? zh ? '正在提交…' : 'Submitting…' : zh ? '确认清理' : 'Confirm cleanup', () => { void cache.confirmCleanup(); }, cache.busy, 'cache-confirm-cleanup')}</View>
      </Modal.Content>
    </Modal> : null}
  </ScrollView>;
}
