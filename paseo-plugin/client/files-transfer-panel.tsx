import { useEffect, useSyncExternalStore, useState } from 'react';
import { View, Text, Pressable, useWindowDimensions } from 'react-native';
import { useRpc } from '@getpaseo/plugin/client';
import { filesRpc } from '../shared/file-rpc';
import { fileTransferStore, type FileTransferStore } from './files-store';
import { canSave, DownloadStaging, pickFiles } from './files-platform';
import { useWorkbenchLocale } from './i18n';
import { ScrollView } from './native-components';

export const fileBytes = (n: number | null) => n === null ? '—' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KiB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MiB' : (n / 1073741824).toFixed(2) + ' GiB';
export function useFileConnection(project: string, scope: string, enabled: boolean) {
  const call = useRpc(filesRpc), store = fileTransferStore(scope);
  useEffect(() => enabled ? store.bind(async request => { const result = await call({ projectConfig: project, request: request as any }); if (!result.ok) { const error = new Error(result.error?.message || 'File request failed') as Error & { code?: string }; error.code = result.error?.code; throw error; } return result.result; }) : undefined, [call, project, store, enabled]);
  return store;
}
export function FileTransfers({ store, theme }: { store: FileTransferStore; theme: any }) {
  const zh = useWorkbenchLocale() === 'zh-CN', snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot), [open, setOpen] = useState(false), [batch, setBatch] = useState(false), [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const { height } = useWindowDimensions();
  const c = theme.colors, active = snapshot.tasks.filter(t => t.cleanupPending || !['complete', 'cancelled', 'delegated'].includes(t.state));
  const run = (work: () => Promise<unknown>) => { setError(''); void work().catch(e => setError(String(e.message || e))); };
  const labels: Record<string, string> = zh ? { queued: '等待中', preparing: '正在准备', active: '传输中', paused: '已暂停', interrupted: '已中断 · 可继续', conflict: '同名冲突', ready_to_save: '等待保存', complete: '已完成', cancelled: '已取消', failed: '需要处理', delegated: '交由浏览器下载' } : { queued: 'Queued', preparing: 'Preparing', active: 'Transferring', paused: 'Paused', interrupted: 'Interrupted · resumable', conflict: 'Name conflict', ready_to_save: 'Ready to save', complete: 'Complete', cancelled: 'Cancelled', failed: 'Needs attention', delegated: 'Handed to browser' };
  const button = (label: string, onPress: () => void, key = label) => <Pressable key={key} accessibilityRole="button" onPress={onPress} style={{ paddingHorizontal: 7, paddingVertical: 5, borderRadius: 4, backgroundColor: c.surface2 || c.surface0 }}><Text style={{ color: c.foreground, fontSize: 11 }}>{label}</Text></Pressable>;
  const control = (id: string, command: string) => run(async () => { const source = active.find(t => t.id === id); await store.control(id, command); if (batch && source?.batchId && source.conflict !== 'changed' && ['skip', 'keep', 'replace'].includes(command)) { store.applyBatchPolicy(source.batchId, command); for (const task of active.filter(t => t.state === 'conflict' && t.id !== id && t.batchId === source.batchId && t.conflict !== 'changed' && !(command === 'replace' && t.canReplace === false))) await store.control(task.id, command); } });
  return <View style={{ borderTopWidth: 1, borderTopColor: c.border || c.foregroundMuted, backgroundColor: c.surface1 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={zh ? '传输队列' : 'Transfers'} accessibilityState={{ expanded: open }} onPress={() => { setOpen(!open); void store.poll(); }} style={{ paddingHorizontal: 8, paddingVertical: 5, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
      <Text style={{ color: c.foreground, fontSize: 12 }}>{open ? '⌄' : '›'} {zh ? '传输' : 'Transfers'} · {active.length} {zh ? '项待完成' : 'pending'}</Text>
      <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 10, flexShrink: 1, textAlign: 'right' }}>{zh ? '远程临时' : 'Remote temporary'} {fileBytes(snapshot.temporaryBytes)} · {zh ? '本机暂存' : 'Local staging'} {fileBytes(snapshot.localBytes)}</Text>
    </Pressable>
    {open ? <ScrollView style={{ maxHeight: Math.max(96, Math.min(180, height * 0.25)) }} contentContainerStyle={{ padding: 7, gap: 8 }}>
      {snapshot.error || error ? <Text style={{ color: c.statusWarning || '#eabf6c', fontSize: 11 }}>{error || snapshot.error}</Text> : null}
      {!snapshot.tasks.length ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{zh ? '暂无传输任务。把文件拖到目录即可上传。' : 'Drop files onto a directory to upload.'}</Text> : null}
      {active.some(t => t.state === 'conflict') ? button(`${batch ? '☑' : '☐'} ${zh ? '应用于当前批次冲突' : 'Apply to current conflicts'}`, () => setBatch(!batch)) : null}
      {snapshot.tasks.slice(Math.min(page, Math.max(0, Math.ceil(snapshot.tasks.length/50)-1))*50, (Math.min(page, Math.max(0, Math.ceil(snapshot.tasks.length/50)-1))+1)*50).map(task => <View key={task.id} style={{ gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 12, flex: 1 }}>{task.direction === 'upload' ? '↑' : task.direction === 'download' ? '↓' : '↔'} {task.name} · {task.workspaceName}</Text>
          {task.size !== null ? <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>{fileBytes(task.offset)} / {fileBytes(task.size)}{task.speed ? ` · ${fileBytes(task.speed)}/s` : ''}</Text> : null}
        </View>
        <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 10 }}>{task.path || '/'} · {task.cleanupPending ? zh ? '恢复内容待清理' : 'Recovery cleanup pending' : labels[task.state] || task.state}{task.state === 'preparing' && task.processed !== undefined ? ` · ${task.processed} ${zh ? '个条目' : 'entries'}` : ''}</Text>
        {task.size !== null ? <View style={{ height: 3, backgroundColor: c.surface0 }}><View style={{ height: 3, width: `${Math.min(100, task.size === 0 ? task.state === 'complete' ? 100 : 0 : task.offset / task.size * 100)}%`, backgroundColor: c.accent || '#78a9ff' }} /></View> : null}
        {task.excluded ? <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>{zh ? '已跳过内部元数据入口' : 'Internal metadata entries skipped'} · {task.excluded}</Text> : null}
        {task.localError || task.error ? <Text style={{ color: c.statusWarning || '#eabf6c', fontSize: 11 }}>{task.localError || task.error}</Text> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
          {task.cleanupPending ? button(zh ? '重试远程清理' : 'Retry remote cleanup', () => control(task.id, 'cancel')) : null}
          {['complete', 'cancelled', 'delegated'].includes(task.state) && task.stagedBytes ? button(zh ? '清理本机暂存' : 'Clean local staging', () => run(() => store.cleanup(task.id))) : null}
          {task.state === 'conflict' ? <>{button(zh ? '跳过' : 'Skip', () => control(task.id, 'skip'))}{button(zh ? '保留两份' : 'Keep both', () => control(task.id, 'keep'))}{task.canReplace !== false ? button(zh ? '替换' : 'Replace', () => control(task.id, 'replace')) : null}</> : null}
          {!['complete', 'cancelled', 'delegated', 'conflict'].includes(task.state) ? <>
            {task.needsSource ? button(zh ? '重新选择原文件' : 'Select original file', () => pickFiles(false, files => { if (files[0]) run(() => store.attach(task.id, files[0])); })) : null}
            {['active', 'preparing', 'queued'].includes(task.state) && !task.localError ? button(zh ? '暂停' : 'Pause', () => control(task.id, 'pause')) : button(zh ? '继续 / 重试' : 'Resume / retry', () => control(task.id, 'resume'))}
            {task.direction === 'download' && !task.saving && task.size !== null && canSave() && (task.state === 'ready_to_save' || !DownloadStaging.supported()) ? button(zh ? '保存到本机' : 'Save to device', () => { void store.save(task.id); }) : null}
            {task.saving ? <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{zh ? '正在保存…' : 'Saving…'}</Text> : null}
            {task.direction === 'download' && !task.saving && task.localError && ['active', 'ready_to_save'].includes(task.state) && canSave() ? button(zh ? '直接保存到本机' : 'Save directly to device', () => { void store.save(task.id, true); }) : null}
            {task.direction === 'download' && task.size !== null && !canSave() ? button(zh ? '交由浏览器下载' : 'Browser download', () => run(() => store.delegate(task.id))) : null}
            {button(zh ? '取消并清理' : 'Cancel and clean up', () => control(task.id, 'cancel'))}
          </> : null}
        </View>
      </View>)}
      {snapshot.tasks.length > 50 ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>{button(zh ? '上一页' : 'Previous', () => setPage(p => Math.max(0, p-1)))}<Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{page+1} / {Math.ceil(snapshot.tasks.length/50)}</Text>{button(zh ? '下一页' : 'Next', () => setPage(p => Math.min(Math.ceil(snapshot.tasks.length/50)-1,p+1)))}</View> : null}
    </ScrollView> : null}
  </View>;
}
