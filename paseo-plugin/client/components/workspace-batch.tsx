import { useState } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Modal, ScrollView } from '../native-components';
import { useWorkbenchCopy } from '../i18n';
import { batchExecutable, type BatchState, type createWorkspaceBatch } from '../workspace-batch';
import { makeStyles, workspaceDisplayName } from './ui';
type Controller = ReturnType<typeof createWorkspaceBatch>;
export function WorkspaceBatchPanel({ state, controller, styles }: {
  state: BatchState; controller: Controller; styles: ReturnType<typeof makeStyles>;
}) {
  const copy = useWorkbenchCopy();
  const { height } = useWindowDimensions();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const labels = { queued: copy.batchQueued, checking: copy.batchChecking, eligible: copy.batchEligible, consent: copy.batchConsent,
    blocked: copy.batchBlocked, running: copy.batchRunning, complete: copy.batchComplete, failed: copy.batchFailed, uncertain: copy.batchUncertain, skipped: copy.batchSkipped };
  const actionable = state.entries.filter(batchExecutable);
  const button = (label: string, onPress: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.secondaryButton, disabled && { opacity: 0.45 }]}><Text style={styles.secondaryButtonText}>{label}</Text></Pressable>;
  return <Modal open={state.open} onOpenChange={open => { if (!open) controller.close(); }} title={`${state.action === 'remove' ? copy.batchRemove : state.action === 'restore' ? copy.batchRestore : copy.batchDelete} · ${state.entries.length}`}>
    <Modal.Content style={styles.deletionModalContent}>
    <ScrollView style={{ maxHeight: Math.max(160, height - 180) }} contentContainerStyle={styles.deletionModalBody}>
      {state.action !== 'restore' ? <Text style={styles.deletionModalText}>{state.action === 'delete' ? copy.batchPreserved : copy.batchRemoveHint}</Text> : null}
      {state.entries.map(entry => <View key={entry.target.id} style={styles.deletionModalSection}>
        <Text style={styles.deletionModalSectionTitle}>{workspaceDisplayName(entry.target, copy)} · {labels[entry.phase]}</Text>
        {entry.error ? <Text selectable style={styles.deletionModalText}>{entry.error === 'workspace_task_active' ? copy.workspaceDeleteRunningTask : entry.error}</Text> : null}
        {entry.impact ? button(copy.batchDetails, () => setExpanded(values => ({ ...values, [entry.target.id]: !values[entry.target.id] }))) : null}
        {entry.impact && expanded[entry.target.id] ? <View>
          {entry.impact.dataLossSummary?.repositories.map(repo => <Text key={repo.repositoryId} selectable style={styles.deletionModalText}>{repo.repositoryId} · {repo.pathCount}{'\n'}{repo.paths.join('\n')}{repo.scanUnavailable ? `\n${copy.workspaceDeleteDataLossIncomplete}` : ''}</Text>)}
          {entry.impact.dataLossSummary?.extraPaths.map(path => <Text key={path} selectable style={styles.deletionModalText}>{path}</Text>)}
          {entry.impact.dataLossSummary?.scanIncomplete ? <Text style={styles.deletionModalText}>{copy.workspaceDeleteDataLossIncomplete}</Text> : null}
          {entry.impact.gitIdentityWarnings?.map((warning, i) => <Text key={i} selectable style={styles.deletionModalText}>{warning.repositoryId} · {warning.code}</Text>)}
          {entry.phase === 'consent' && state.phase === 'confirm' ? <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: entry.consent }} onPress={() => controller.consent(entry.target.id, !entry.consent)} style={styles.layoutMenuItem}><Text style={styles.deletionModalDanger}>{entry.consent ? '☑' : '☐'} {copy.batchLossConsent}</Text></Pressable> : null}
        </View> : null}
      </View>)}
      {state.phase === 'confirm' ? <><Text style={styles.deletionModalText}>{copy.batchTargets} ({actionable.length}): {actionable.map(entry => workspaceDisplayName(entry.target, copy)).join(', ')}</Text>{button(copy.batchConfirm, () => { void controller.confirm(); }, !actionable.length)}</> : null}
      {state.phase === 'running' || state.phase === 'complete' ? <Text style={styles.deletionModalText}>{(['complete','failed','uncertain','skipped','blocked'] as const).map(phase => `${labels[phase]} ${state.entries.filter(entry => entry.phase === phase).length}`).join(' · ')}</Text> : null}
      <View style={[styles.deletionModalActions, { flexWrap: 'wrap' }]}>
        {state.phase === 'running' ? button(copy.batchStop, controller.stop) : null}
        {state.phase === 'complete' && state.entries.some(entry => entry.phase === 'failed') ? button(copy.batchRetry, () => { setExpanded({}); void controller.retryFailed(); }) : null}
        {state.phase === 'complete' && state.entries.some(entry => entry.phase === 'uncertain') ? button(copy.batchReconcile, () => { void controller.reconcileUncertain(); }) : null}
        {button(copy.batchClose, controller.close)}
      </View>
    </ScrollView>
    </Modal.Content>
  </Modal>;
}
