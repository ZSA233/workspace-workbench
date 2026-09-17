import { Modal } from "@getpaseo/plugin/client/react-native";
import { Platform, Pressable, Text, View } from "react-native";
import { formatCopyFrom } from "../../shared/copy";
import type { WorkspaceLifecycleResponse } from "../../shared/workspace-lifecycle";
import type { WorkspaceDeletionImpact, WorkspaceSummary, WorkspaceTask } from "../model";
import { useWorkbenchCopy } from "../i18n";
import { isMainWorkspace, makeStyles, repositoryCountLabel, workspaceDisplayName } from "./ui";

type PanelProps = { theme: { colors: Record<string, string> } };

function isImpact(value: unknown): value is WorkspaceDeletionImpact {
  return Boolean(value && typeof value === "object" && "workspaceId" in value && "preview" in value);
}

function taskLabel(task: WorkspaceTask, fallback: string): string {
  return [task.label || fallback, task.status].filter(Boolean).join(" · ");
}

export function WorkspaceDeletionPanel({
  open,
  workspace,
  mode,
  response,
  busy,
  error,
  onClose,
  onRemove,
  onRestore,
  onConfirmPermanent,
  onOpenTask,
  theme,
  styles,
}: {
  open: boolean;
  workspace?: WorkspaceSummary;
  mode: "inspect" | "permanent";
  response: WorkspaceLifecycleResponse | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onRemove: () => void;
  onRestore: () => void;
  onConfirmPermanent: () => void;
  onOpenTask?: (task: WorkspaceTask) => void;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const copy = useWorkbenchCopy();
  if (!open || !workspace || isMainWorkspace(workspace)) return null;
  const impact = isImpact(response?.result) ? response.result : null;
  const tasks = response ? response.activeTasks : workspace.deletion?.activeTasks || [];
  const removed = workspace.state === "removed";
  const pendingState = workspace.state === "deletion_pending";
  const pending = pendingState || Boolean(tasks.length);
  const dirty = workspace.dirty === true || Boolean(impact?.dirtyRepositories);
  const unpushed = workspace.unpushed === true;
  const externalReferences = impact?.externalReferences || [];
  const branches = impact?.branchesPreserved?.length ? impact.branchesPreserved : [];
  const runtimeState = impact?.runtimeState;
  const runtimeRecordCount = (runtimeState?.agentBinding ? 1 : 0) + (runtimeState?.reviewSessionCount || 0);
  const title = mode === "permanent" ? copy.workspacePermanentDelete : copy.workspaceDeleteTitle;
  return <Modal open onOpenChange={(nextOpen) => { if (!nextOpen && !busy) onClose(); }} title={title}>
    <Modal.Content scrollable={Platform.OS === "web"} style={styles.deletionModalContent} contentContainerStyle={styles.deletionModalBody}>
      <Text style={styles.deletionModalTitle}>{workspaceDisplayName(workspace, copy)}</Text>
      <Text style={styles.deletionModalText}>{copy.workspaceDeleteDescription}</Text>

      {pending && tasks.length ? <View style={[styles.deletionModalSection, { borderColor: theme.colors.statusWarning }]}>
        <Text style={[styles.deletionModalSectionTitle, { color: theme.colors.statusWarning }]}>{copy.workspaceDeleteRunningTask}</Text>
        {tasks.map((task, index) => <View key={`${task.kind}-${task.id || index}`} style={styles.deletionModalRow}>
          <Text style={[styles.deletionModalBullet, { color: theme.colors.statusWarning }]}>•</Text>
          <Text style={styles.deletionModalRowText}>{taskLabel(task, copy.workspaceDeleteRunningTask)}</Text>
          {onOpenTask && task.id ? <Pressable accessibilityRole="button" onPress={() => onOpenTask(task)}><Text style={styles.secondaryButtonText}>{copy.text_f7acefd2d4}</Text></Pressable> : null}
        </View>)}
        <Text style={styles.deletionModalText}>{copy.workspaceDeleteStopTask}</Text>
      </View> : null}
      {pendingState && !tasks.length ? <Text style={styles.deletionModalText}>{copy.workspaceDeleteReady}</Text> : null}

      <View style={styles.deletionModalSection}>
        <Text style={styles.deletionModalSectionTitle}>{copy.workspaceDeletePreserve}</Text>
        <View style={styles.deletionModalRow}><Text style={styles.deletionModalBullet}>•</Text><Text style={styles.deletionModalRowText}>{copy.workspaceDeleteBranchPreserved}</Text></View>
        <View style={styles.deletionModalRow}><Text style={styles.deletionModalBullet}>•</Text><Text style={styles.deletionModalRowText}>{repositoryCountLabel(workspace.repositoryCount, copy)}</Text></View>
      </View>
      {impact?.detachedSafetyRefs?.length ? <View style={styles.deletionModalSection}>
        <Text style={styles.deletionModalSectionTitle}>{copy.orphanSafetyRefs}</Text>
        {impact.detachedSafetyRefs.map(item => <Text key={item.ref} selectable style={styles.deletionModalRowText}>{item.repositoryId} · {item.ref} · {item.head.slice(0, 8)}</Text>)}
      </View> : null}

      {dirty ? <View style={styles.deletionModalRow}><Text style={[styles.deletionModalBullet, { color: theme.colors.statusWarning }]}>•</Text><Text style={styles.deletionModalRowText}>{copy.workspaceDeleteDirty}{workspace.dirtyRepositoryCount ? ` · ${workspace.dirtyRepositoryCount}` : ""}</Text></View> : null}
      {unpushed ? <View style={styles.deletionModalRow}><Text style={[styles.deletionModalBullet, { color: theme.colors.statusWarning }]}>•</Text><Text style={styles.deletionModalRowText}>{copy.workspaceDeleteUnpushed}</Text></View> : null}
      {externalReferences.length ? <View style={styles.deletionModalSection}>
        <Text style={styles.deletionModalSectionTitle}>{copy.workspaceDeleteExternal}</Text>
        {externalReferences.slice(0, 6).map((reference, index) => <Text key={`${reference.repository}-${reference.ref}-${index}`} style={styles.deletionModalRowText}>{reference.repository || "Git"} · {reference.ref || "unknown"}</Text>)}
      </View> : null}

      {runtimeRecordCount > 0 ? <View style={[styles.deletionModalSection, { borderColor: mode === "permanent" ? theme.colors.statusDanger : theme.colors.statusWarning }]}>
        <Text style={[styles.deletionModalSectionTitle, { color: mode === "permanent" ? theme.colors.statusDanger : theme.colors.statusWarning }]}>{copy.workspaceDeleteRuntimeState}</Text>
        <Text style={styles.deletionModalText}>{copy.workspaceDeleteRuntimeImpact}</Text>
        {runtimeState?.agentBinding ? <View style={styles.deletionModalRow}><Text style={styles.deletionModalBullet}>•</Text><Text style={styles.deletionModalRowText}>{copy.workspaceDeleteRuntimeBinding}</Text></View> : null}
        {(runtimeState?.reviewSessionCount || 0) > 0 ? <View style={styles.deletionModalRow}><Text style={styles.deletionModalBullet}>•</Text><Text style={styles.deletionModalRowText}>{formatCopyFrom(copy, "workspaceDeleteRuntimeReview", [runtimeState?.reviewSessionCount || 0])}</Text></View> : null}
      </View> : null}

      {mode === "permanent" ? <View style={[styles.deletionModalSection, { borderColor: theme.colors.statusDanger }]}>
        <Text style={styles.deletionModalDanger}>{copy.workspaceDeletePermanentWarning}</Text>
        {impact?.loses?.map((item) => <View key={item} style={styles.deletionModalRow}><Text style={[styles.deletionModalBullet, { color: theme.colors.statusDanger }]}>•</Text><Text style={styles.deletionModalRowText}>{item}</Text></View>)}
        {branches.length ? <Text style={styles.deletionModalRowText}>{copy.workspaceDeleteBranchPreserved} · {branches.slice(0, 3).join(", ")}</Text> : null}
      </View> : null}

      {error ? <Text style={styles.deletionModalDanger}>{error}</Text> : null}
      {!response && !busy ? <Text style={styles.deletionModalText}>{copy.workspaceDeleteUnavailable}</Text> : null}
      {busy ? <Text style={styles.deletionModalText}>{copy.text_fcabadb2a7}</Text> : null}
      <View style={styles.deletionModalActions}>
        <Pressable accessibilityRole="button" disabled={busy} onPress={onClose} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{copy.workspaceDeleteCancel}</Text></Pressable>
        {(removed || pending) && mode === "inspect" ? <Pressable accessibilityRole="button" disabled={busy} onPress={onRestore} style={styles.copyButton}><Text style={styles.copyButtonText}>{copy.workspaceRestore}</Text></Pressable> : null}
        {pendingState && !tasks.length && mode === "inspect" ? <Pressable accessibilityRole="button" disabled={busy} onPress={onRemove} style={styles.copyButton}><Text style={styles.copyButtonText}>{copy.workspaceDelete}</Text></Pressable> : null}
        {!removed && mode === "inspect" && !pendingState ? <Pressable accessibilityRole="button" disabled={busy} onPress={onRemove} style={styles.copyButton}><Text style={styles.copyButtonText}>{copy.workspaceDelete}</Text></Pressable> : null}
        {removed && mode === "permanent" ? <Pressable accessibilityRole="button" disabled={busy} onPress={onConfirmPermanent} style={[styles.copyButton, { backgroundColor: theme.colors.statusDanger, borderColor: theme.colors.statusDanger }]}><Text style={styles.copyButtonText}>{copy.workspaceDeleteConfirm}</Text></Pressable> : null}
      </View>
    </Modal.Content>
  </Modal>;
}
