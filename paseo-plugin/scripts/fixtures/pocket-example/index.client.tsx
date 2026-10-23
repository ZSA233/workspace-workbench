import { useEffect, useState } from 'react';
import { Text, View, Pressable } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useRpc } from '@getpaseo/plugin/client';
import { connectPocket } from './client/pocket-sdk';
import { examplePing } from './shared/protocol';

// A separate, real fixture plugin: only the documented SDK and ordinary Paseo APIs.
export default function contribute(client: any) {
  const pocket = connectPocket(client), handles = new Map();
  const proof = (globalThis as any).__pocketExampleProof = { mounted: 0, maximum: 0, reads: 0, cacheShared: true, queryClient: null };
  for (let n = 1; n <= 8; n++) {
    function Example(props: any) {
      const ping = useRpc(examplePing), cache = useQueryClient();
      const [result, setResult] = useState('Loading example RPC');
      useEffect(() => {
        proof.mounted++; proof.maximum = Math.max(proof.maximum, proof.mounted);
        if (proof.queryClient && proof.queryClient !== cache) proof.cacheShared = false;
        proof.queryClient = cache;
        return () => { proof.mounted--; };
      }, [cache]);
      useEffect(() => {
        let active = true; proof.reads++;
        void ping({ workspaceId: props.workspaceId, panel: n }).then(value => { if (active) setResult(`${value.plugin} RPC ${value.panel}: ${value.workspaceId}`); });
        return () => { active = false; };
      }, [ping, props.workspaceId]);
      return <View style={{ flex: 1, padding: 12, gap: 12 }}>
        <Text testID={`example-context-${n}`} style={{ color: props.theme.colors.foreground }}>Inspector {n}: {props.workspaceId} / {props.agentId || 'workspace'}</Text>
        <Text testID={`example-rpc-${n}`} style={{ color: props.theme.colors.foreground }}>{result}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Retitle example tab" onPress={() => handles.get(n)?.update({ title: `Retitled ${n}` })}><Text style={{ color: props.theme.colors.accent }}>Retitle example tab</Text></Pressable>
      </View>;
    }
    client.addWorkspacePanel({ id: `example-workspace-${n}`, title: `Inspector ${n}`, icon: 'GitBranch', context: 'workspace', locations: ['explorer'], Component: Example });
    client.addWorkspacePanel({ id: `example-agent-${n}`, title: `Inspector ${n}`, icon: 'GitBranch', context: 'agent', locations: ['explorer'], Component: Example });
    const handle = pocket?.ui.registerPanel({ id: `inspector-${n}`, title: n === 8 ? 'Inspector with a deliberately long title' : `Inspector ${n}`, icon: 'GitBranch', location: 'right-sidebar',
      content: { workspacePanelId: `example-workspace-${n}`, agentPanelId: `example-agent-${n}` } });
    handles.set(n, handle);
  }
  return () => pocket?.dispose();
}
