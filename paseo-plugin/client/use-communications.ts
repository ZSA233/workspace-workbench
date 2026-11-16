import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRpc } from '@getpaseo/plugin/client';
import { extensionsRpc, communicationsConnectionRpc, type ServiceConnection } from '../shared/extensions';
import { communicationsRpc, communicationsDeliveryRpc, type CommunicationsAction, type Snapshot } from '../shared/extensions/project-communications/shared';

export function useCommunications(projectConfig: string, foreground: boolean, visible: boolean) {
  const extensionRpc = useRpc(extensionsRpc), rpc = useRpc(communicationsRpc), deliveryRpc = useRpc(communicationsDeliveryRpc);
  const connectionRpc = useRpc(communicationsConnectionRpc);
  const scope = useRef(projectConfig); scope.current = projectConfig;
  const [failure, setFailure] = useState<{ project: string; message: string } | null>(null);
  const [changing, setChanging] = useState(false);
  const extension = useQuery({ queryKey: ['workbench-extensions', projectConfig, 'project-communications'],
    queryFn: () => extensionRpc({ projectConfig, extensionId: 'project-communications', action: 'status' }),
    enabled: foreground, refetchInterval: foreground ? 10000 : false, retry: false, refetchOnWindowFocus: false });
  const enabled = extension.data?.enabled === true;
  const connection = useQuery({queryKey:['communications-connection',projectConfig],queryFn:()=>connectionRpc({projectConfig,extensionId:'project-communications',action:'read'}),enabled:foreground&&visible,retry:false,refetchOnWindowFocus:false});
  const scopeKey=`${projectConfig}:${connection.data?.revision??'loading'}`;
  const connectionScope=useRef(scopeKey);connectionScope.current=scopeKey;
  useEffect(()=>{setFailure(null);setChanging(false);},[scopeKey]);
  const snapshot = useQuery({ queryKey: ['workbench-communications', projectConfig, connection.data?.revision],
    queryFn: async () => await rpc({ projectConfig, extensionId: 'project-communications', request: { action: 'snapshot' } }) as Snapshot,
    enabled: enabled && foreground && visible, refetchInterval: foreground && visible ? 2500 : false,
    retry: false, refetchOnWindowFocus: false });
  const refresh = snapshot.refetch, refreshExtension = extension.refetch;
  const call = useCallback(async <T = unknown,>(request: CommunicationsAction): Promise<T> => {
    const capturedScope=connectionScope.current;
    try {
      const endpoint = request.action.startsWith('delivery.') && request.action !== 'delivery.preview' ? deliveryRpc : rpc;
      const result = await endpoint({ projectConfig, extensionId: 'project-communications', request });
      if (scope.current !== projectConfig||connectionScope.current!==capturedScope) throw Error('project_connection_changed');
      setFailure(null);
      // Read operations must not trigger another snapshot read or reset a reader.
      if (!['snapshot','messages.list','candidate.list','requirement.list','messages.read','attachment.read','requirement.history','groups.search','delivery.targets'].includes(request.action)) {
        void refresh({ cancelRefetch: false }); void refreshExtension({ cancelRefetch: false });
      }
      return result as T;
    } catch (error) {
      if (scope.current === projectConfig&&connectionScope.current===capturedScope) setFailure({ project: projectConfig, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }, [projectConfig, rpc, deliveryRpc, refresh, refreshExtension]);
  const setEnabled = useCallback(async (value: boolean) => {
    setChanging(true);
    try {
      await extensionRpc({ projectConfig, extensionId: 'project-communications', action: value ? 'enable' : 'disable' });
      if (scope.current === projectConfig) { setFailure(null); await refreshExtension(); if (value) void refresh(); }
    } catch (error) { if (scope.current === projectConfig) setFailure({ project: projectConfig, message: String(error) }); }
    finally { if (scope.current === projectConfig) setChanging(false); }
  }, [projectConfig, extensionRpc, refresh, refreshExtension]);
  const updateConnection = async (config:ServiceConnection, revision:number, token?:string) => {
    await connectionRpc({projectConfig,extensionId:'project-communications',action:'configure',connection:config,revision,...(token===undefined?{}:{token})});
    await connection.refetch();await refreshExtension();if(enabled)void refresh();
  };
  const checkConnection = () => connectionRpc({projectConfig,extensionId:'project-communications',action:'check'});
  return { projectConfig, scopeKey, enabled, changing, setEnabled, call, refresh, connection:connection.data,updateConnection,checkConnection,snapshot: snapshot.data,
    state: extension.data, loading: snapshot.isLoading, refreshing: snapshot.isFetching,
    unread: snapshot.data?.unread ?? extension.data?.unread ?? 0,
    error: failure?.project === projectConfig ? failure.message : snapshot.error?.message || extension.error?.message || extension.data?.error || '',
  };
}
export type CommunicationsClient = ReturnType<typeof useCommunications>;
