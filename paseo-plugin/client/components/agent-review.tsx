import { Pressable, Text, View } from "react-native";
import * as React from "react";
import type { PluginAgentPanelProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { ReviewSession } from "../../shared/agent-review";
import { StatusPill, makeStyles } from "./ui";

type PanelProps = PluginWorkspacePanelProps | PluginAgentPanelProps;

function statusLabel(status: ReviewSession["status"]): string {
  return {
    waiting_execution: "等待执行",
    ready_for_review: "待审核",
    queued: "排队中",
    reviewing: "审核中",
    changes_requested: "需要修改",
    fixing: "修复中",
    approved: "已通过",
    blocked: "已阻塞",
    failed: "失败",
    stopping: "正在停止",
    stopped: "已停止",
    limit_reached: "达到上限",
  }[status];
}

function eventDetails(event: ReviewSession["events"][number]): string {
  const details = Object.entries(event.details || {}).filter(([key]) => !["snapshot", "diff"].includes(key));
  if (!details.length) return "";
  try {
    return JSON.stringify(Object.fromEntries(details), null, 2).slice(0, 1800);
  } catch {
    return "";
  }
}

export function AgentReviewView({
  session,
  history,
  loading,
  onStart,
  onReview,
  onRepair,
  onStop,
  onResume,
  onSelectHistory,
  theme,
  styles,
}: {
  session: ReviewSession | null;
  history: ReviewSession[];
  loading: boolean;
  onStart: () => void;
  onReview: () => void;
  onRepair: () => void;
  onStop: () => void;
  onResume: () => void;
  onSelectHistory: (sessionId: string) => void;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  if (loading && !session) return <Text style={styles.emptyText}>正在读取审核流程…</Text>;
  if (!session) {
    return <View style={styles.reviewPanel}>
      <Text style={styles.sectionTitle}>Agent Review</Text>
      <Text style={styles.emptyText}>当前 Workspace 还没有审核流程。</Text>
      <Pressable accessibilityRole="button" onPress={onStart} style={styles.secondaryButton}>
        <Text style={styles.secondaryButtonText}>开始审核</Text>
      </Pressable>
    </View>;
  }
  const active = ["queued", "reviewing", "fixing", "stopping"].includes(session.status);
  const canReview = session.status === "ready_for_review";
  const canManualStart = session.status === "waiting_execution";
  const canRepair = session.status === "changes_requested";
  const canResume = ["stopped", "failed", "blocked"].includes(session.status);
  const canStartNew = ["approved", "limit_reached"].includes(session.status);
  return <View style={styles.reviewPanel}>
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>Agent Review</Text>
      <StatusPill status={session.status} label={statusLabel(session.status)} theme={theme} styles={styles} />
    </View>
    {history.length > 1 ? <View>
      <Text style={styles.reviewEntryMeta}>历史流程：{history.length} 个 · 当前 {session.id.slice(0, 8)}</Text>
      <View style={styles.briefActions}>{history.slice().reverse().map((item) => <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: item.id === session.id }} onPress={() => onSelectHistory(item.id)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{item.id.slice(0, 8)} · {statusLabel(item.status)}</Text></Pressable>)}</View>
    </View> : null}
    <Text style={styles.reviewEntryMeta}>第 {session.round || 1} / {session.maxRounds} 轮 · 执行 Agent {session.executionAgentId ? session.executionAgentId.slice(0, 8) : "未绑定"}</Text>
    <Text style={styles.reviewEntryMeta}>执行模型：{session.executionModelId || session.preferences.executionModel || "跟随会话"} · Reviewer：{session.reviewerModelId || session.preferences.reviewerModel || "跟随执行模型"}</Text>
    {session.snapshotId ? <Text selectable style={styles.reviewEntryMeta}>版本：{session.snapshotId.slice(0, 12)} · 差异：{session.diffId?.slice(0, 12)}</Text> : null}
    {session.lastError ? <Text style={styles.warningText}>{session.lastError.code}：{session.lastError.message}</Text> : null}
    <View style={styles.reviewTimeline}>
      {session.events.map((event) => {
        const open = Boolean(expanded[event.id]);
        const details = eventDetails(event);
        return <View key={event.id} style={styles.reviewTimelineNode}>
          <View style={styles.reviewTimelineDot} />
          <View style={styles.reviewEntryCopy}>
            <View style={styles.sectionHeader}>
              <Text style={styles.reviewBranch}>{event.kind.replaceAll("_", " ")}</Text>
              <Text style={styles.reviewEntryMeta}>{new Date(event.createdAt).toLocaleTimeString()}</Text>
            </View>
            <Text style={styles.reviewEntryMeta}>{event.summary}</Text>
            {details ? <Pressable accessibilityRole="button" onPress={() => setExpanded((current) => ({ ...current, [event.id]: !open }))}>
              <Text style={styles.layoutMenuHint}>{open ? "收起详情" : "展开详情"}</Text>
            </Pressable> : null}
            {open ? <Text selectable style={styles.reviewDetailText}>{details}</Text> : null}
          </View>
        </View>;
      })}
    </View>
    <View style={styles.briefActions}>
      {canReview ? <Pressable accessibilityRole="button" onPress={onReview} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>开始审核</Text></Pressable> : null}
      {canManualStart ? <Pressable accessibilityRole="button" onPress={onStart} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>手动开始审核</Text></Pressable> : null}
      {canRepair ? <Pressable accessibilityRole="button" onPress={onRepair} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>继续修复</Text></Pressable> : null}
      {active ? <Pressable accessibilityRole="button" onPress={onStop} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>停止流程</Text></Pressable> : null}
      {canResume ? <Pressable accessibilityRole="button" onPress={onResume} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>恢复流程</Text></Pressable> : null}
      {canStartNew ? <Pressable accessibilityRole="button" onPress={onStart} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>开始新的审核</Text></Pressable> : null}
    </View>
  </View>;
}
