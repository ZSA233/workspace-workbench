import { useCallback, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRpc } from '@getpaseo/plugin/client';
import { communicationsConnectionRpc, extensionsRpc, type ServiceConnection } from '../shared/extensions.ts';
import { archiveTopicsRpc, archiveTopicsDeliveryRpc, type ArchiveDirectory, type TopicAction } from '../shared/extensions/project-communications/topics.ts';

export function useTopics(projectConfig: string, foreground: boolean, visible: boolean) {
  const extensionRpc = useRpc(extensionsRpc), connectionRpc = useRpc(communicationsConnectionRpc);
  const rpc = useRpc(archiveTopicsRpc), deliveryRpc = useRpc(archiveTopicsDeliveryRpc), cache = useQueryClient();
  const [failure, setFailure] = useState<{ scope: string; message: string }>(), [changing, setChanging] = useState(false);
  const extension = useQuery({ queryKey: ['workbench-extensions', projectConfig, 'project-communications'],
    queryFn: () => extensionRpc({ projectConfig, extensionId: 'project-communications', action: 'status' }),
    enabled: foreground, retry: false, refetchInterval: foreground && visible ? 20000 : false, refetchOnWindowFocus: false });
  const connection = useQuery({ queryKey: ['communications-connection', projectConfig], queryFn: () => connectionRpc({ projectConfig, extensionId: 'project-communications', action: 'read' }),
    enabled: foreground && visible, retry: false, refetchOnWindowFocus: false });
  const enabled = extension.data?.enabled === true, revision = connection.data?.revision || 0;
  const scopeKey = projectConfig + ':' + revision, current = useRef(scopeKey); current.current = scopeKey;
  const call = useCallback(async <T = unknown,>(request: TopicAction): Promise<T> => {
    const captured = scopeKey;
    try {
      const endpoint = ['targets', 'models', 'preview', 'send', 'receipt'].includes(request.action) ? deliveryRpc : rpc;
      const result = await endpoint({ projectConfig, extensionId: 'project-communications', connectionRevision: revision, request });
      if (current.current !== captured) throw Error('project_connection_changed');
      setFailure(undefined);
      if (request.action === 'group.configure') void cache.invalidateQueries({ queryKey: ['archive-directory', scopeKey] });
      return result as T;
    } catch (error) {
      if (request.action === 'group.configure') void cache.invalidateQueries({ queryKey: ['archive-directory', scopeKey] });
      if (current.current === captured) setFailure({ scope: captured, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }, [projectConfig, revision, scopeKey, rpc, deliveryRpc, cache]);
  const directory = useQuery({ queryKey: ['archive-directory', scopeKey],
    queryFn: () => call<ArchiveDirectory>({ action: 'directory' }), enabled: foreground && visible && Boolean(connection.data?.hasToken),
    retry: false, staleTime: 60000, refetchOnWindowFocus: false });
  const setEnabled = async (value: boolean) => {
    setChanging(true);
    try { await extensionRpc({ projectConfig, extensionId: 'project-communications', action: value ? 'enable' : 'disable' }); await extension.refetch(); }
    finally { setChanging(false); }
  };
  const updateConnection = async (config: ServiceConnection, expectedRevision: number, token?: string) => {
    await connectionRpc({ projectConfig, extensionId: 'project-communications', action: 'configure', connection: config, revision: expectedRevision, ...(token === undefined ? {} : { token }) });
    await connection.refetch(); await extension.refetch();
  };
  const refresh = useCallback(async () => { await Promise.all([
    cache.invalidateQueries({ queryKey: ['archive-topics', scopeKey] }),
    cache.invalidateQueries({ queryKey: ['archive-topic', scopeKey] }),
    cache.invalidateQueries({ queryKey: ['archive-context', scopeKey] }),
    cache.invalidateQueries({ queryKey: ['archive-directory', scopeKey] }),
  ]); }, [cache, scopeKey]);
  return { projectConfig, scopeKey, enabled, changing, setEnabled, call, refresh, connection: connection.data, updateConnection,
    checkConnection: () => connectionRpc({ projectConfig, extensionId: 'project-communications', action: 'check' }),
    directory: directory.data, active: foreground && visible, loading: directory.isLoading,
    state: extension.data, unread: 0,
    error: failure?.scope === scopeKey ? failure.message : directory.error?.message || connection.error?.message || extension.error?.message || extension.data?.error || '',
    clearError: () => setFailure(undefined),
  };
}
export type TopicsClient = ReturnType<typeof useTopics>;
