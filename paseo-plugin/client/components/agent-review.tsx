import { Pressable, Text, View } from "react-native";
import { ScrollView } from "../native-components";
import * as React from "react";
import type { PluginAgentPanelProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { ReviewEvent, ReviewSession } from "../../shared/agent-review";
import { localizedReviewError, type WorkbenchCopy } from "../../shared/copy";
import { useWorkbenchCopy } from "../i18n";
import { collapseReviewTimelineEvents } from "../model";
import { observerAccent } from "../theme";
import { MiniTag, StatusPill, makeStyles } from "./ui";

type PanelProps = PluginWorkspacePanelProps | PluginAgentPanelProps;
type ReviewStatus = ReviewSession["status"] | "completed";
type TimelineRole = "execution" | "reviewer" | "repair" | "system";

const statusCopyKeys: Partial<Record<ReviewStatus, keyof WorkbenchCopy>> = {
  waiting_execution: "reviewStatusWaitingExecution",
  ready_for_review: "reviewStatusReady",
  queued: "reviewStatusQueued",
  reviewing: "reviewStatusReviewing",
  changes_requested: "reviewStatusChanges",
  fixing: "reviewStatusFixing",
  approved: "reviewStatusApproved",
  blocked: "reviewStatusBlocked",
  failed: "reviewStatusFailed",
  stopping: "reviewStatusStopping",
  stopped: "reviewStatusStopped",
  limit_reached: "reviewStatusLimit",
  completed: "reviewCompleted",
};

const eventCopyKeys: Record<ReviewEvent["kind"], keyof WorkbenchCopy> = {
  started: "reviewEventStarted",
  execution_turn_ended: "reviewEventExecutionTurnEnded",
  ready_for_review: "reviewEventReady",
  review_queued: "reviewEventQueued",
  reviewer_created: "reviewEventReviewerCreated",
  review_started: "reviewEventReviewStarted",
  review_candidate: "reviewEventCandidate",
  review_result: "reviewEventResult",
  repair_requested: "reviewEventRepairRequested",
  repair_sent: "reviewEventRepairSent",
  paused: "reviewEventPaused",
  resumed: "reviewEventResumed",
  stopped: "reviewEventStopped",
  failed: "reviewEventFailed",
  blocked: "reviewEventBlocked",
  expired: "reviewEventExpired",
  finished: "reviewEventFinished",
};

function statusLabel(status: ReviewStatus, copy: WorkbenchCopy): string {
  return copy[statusCopyKeys[status] || "reviewErrorGeneric"];
}

function resultStatus(event: ReviewEvent): ReviewStatus | null {
  if (event.kind === "review_result" || event.kind === "finished") {
    const value = event.details?.verdict || event.details?.status;
    if (value === "approved") return "approved";
    if (value === "changes_requested") return "changes_requested";
    if (value === "blocked") return "blocked";
    if (value === "limit_reached") return "limit_reached";
  }
  if (event.kind === "ready_for_review") return "ready_for_review";
  if (event.kind === "review_queued") return "queued";
  if (["reviewer_created", "review_started", "review_candidate"].includes(event.kind)) return "reviewing";
  if (["repair_requested", "repair_sent"].includes(event.kind)) return "fixing";
  if (event.kind === "failed") return "failed";
  if (["blocked", "expired"].includes(event.kind)) return "blocked";
  if (event.kind === "stopped") return "stopped";
  if (["started", "execution_turn_ended", "resumed"].includes(event.kind)) return "completed";
  return null;
}

function timelineRole(kind: ReviewEvent["kind"]): TimelineRole {
  if (["reviewer_created", "review_started", "review_candidate", "review_result"].includes(kind)) return "reviewer";
  if (["repair_requested", "repair_sent"].includes(kind)) return "repair";
  if (["started", "execution_turn_ended", "ready_for_review"].includes(kind)) return "execution";
  return "system";
}

function roleLabel(role: TimelineRole, copy: WorkbenchCopy): string {
  if (role === "reviewer") return copy.reviewRoleReviewer;
  if (role === "repair") return copy.reviewRoleRepair;
  if (role === "execution") return copy.reviewRoleExecution;
  return copy.reviewTitle;
}

function eventBody(event: ReviewEvent, copy: WorkbenchCopy): string {
  if (event.kind === "review_result" && event.summary.trim()) return event.summary;
  if (event.kind === "ready_for_review" && event.summary.trim() && event.summary !== "Execution handoff recorded") return event.summary;
  if (event.kind === "review_queued" && event.summary.trim()) return event.summary;
  return copy[eventCopyKeys[event.kind]];
}

type FindingLike = {
  id?: unknown;
  severity?: unknown;
  repositoryId?: unknown;
  path?: unknown;
  line?: unknown;
  message?: unknown;
  suggestion?: unknown;
  needsFix?: unknown;
};

type CheckLike = { name?: unknown; status?: unknown; evidence?: unknown };
type CriterionCheckLike = { id?: unknown; status?: unknown; evidence?: unknown };

function findingSeverityLabel(value: unknown, copy: WorkbenchCopy): string {
  if (value === "error") return copy.reviewSeverityError;
  if (value === "warning") return copy.reviewSeverityWarning;
  return copy.reviewSeverityInfo;
}

function findingSeverityColor(value: unknown, theme: PanelProps["theme"]): string {
  if (value === "error") return theme.colors.statusDanger;
  if (value === "warning") return theme.colors.statusWarning;
  return observerAccent(theme);
}

function checkStatusLabel(value: unknown, copy: WorkbenchCopy): string {
  if (value === "passed") return copy.reviewCheckPassed;
  if (value === "failed") return copy.reviewCheckFailed;
  if (value === "unavailable") return copy.reviewCheckUnavailable;
  return copy.reviewCheckNotRun;
}

function checkStatusColor(value: unknown, theme: PanelProps["theme"]): string {
  if (value === "passed") return theme.colors.statusSuccess;
  if (value === "failed") return theme.colors.statusDanger;
  if (value === "unavailable") return theme.colors.statusWarning;
  return theme.colors.foregroundMuted;
}

function eventHasDetails(event: ReviewEvent): boolean {
  return Object.keys(event.details || {}).some((key) => !["snapshot", "diff", "snapshotId", "diffId"].includes(key));
}

function ReviewDetails({ event, copy, theme, styles }: { event: ReviewEvent; copy: WorkbenchCopy; theme: PanelProps["theme"]; styles: ReturnType<typeof makeStyles> }) {
  const details = event.details || {};
  const verdict = typeof details.verdict === "string" ? details.verdict : null;
  const findings = (Array.isArray(details.findings) ? details.findings : []).filter((item): item is FindingLike => Boolean(item && typeof item === "object"));
  const checks = (Array.isArray(details.checks) ? details.checks : []).filter((item): item is CheckLike => Boolean(item && typeof item === "object"));
  const criterionChecks = (Array.isArray(details.criterionChecks) ? details.criterionChecks : []).filter((item): item is CriterionCheckLike => Boolean(item && typeof item === "object"));
  const unreviewed = Array.isArray(details.unreviewed) ? details.unreviewed.filter((item): item is string => typeof item === "string") : [];
  const changes = Array.isArray(details.changes) ? details.changes.filter((item): item is string => typeof item === "string") : [];
  const tests = Array.isArray(details.tests) ? details.tests.filter((item): item is string => typeof item === "string") : [];
  const limitations = Array.isArray(details.knownLimitations) ? details.knownLimitations.filter((item): item is string => typeof item === "string") : [];
  const hidden = new Set(["snapshot", "diff", "snapshotId", "diffId", "findings", "checks", "criterionChecks", "unreviewed", "changes", "tests", "knownLimitations", "verdict"]);
  const technical = Object.fromEntries(Object.entries(details).filter(([key]) => !hidden.has(key)));
  return <View style={styles.reviewDetails}>
    {verdict ? <Text style={styles.reviewDetailMeta}>{copy.reviewLatestResult}: {statusLabel(resultStatus(event) || "reviewing", copy)}</Text> : null}
    {findings.length ? <View style={styles.reviewDetailSection}>
      <Text style={styles.reviewDetailMeta}>{copy.reviewFindingCount.replace("{0}", String(findings.length))}</Text>
      <View style={styles.reviewFindingList}>
        {findings.slice(0, 12).map((finding, index) => {
          const severity = finding.severity;
          const repository = typeof finding.repositoryId === "string" ? finding.repositoryId : "";
          const path = typeof finding.path === "string" ? finding.path : "";
          const line = typeof finding.line === "number" ? `:${finding.line}` : "";
          const message = typeof finding.message === "string" ? finding.message : "";
          const suggestion = typeof finding.suggestion === "string" ? finding.suggestion : "";
          const needsFix = finding.needsFix !== false;
          const color = findingSeverityColor(severity, theme);
          return <View key={typeof finding.id === "string" ? finding.id : `${repository}:${path}:${index}`} style={styles.reviewFindingRow}>
            <MiniTag label={findingSeverityLabel(severity, copy)} color={color} styles={styles} />
            <View style={styles.reviewFindingCopy}>
              <Text selectable numberOfLines={1} style={styles.reviewFindingPath}>{repository ? `${repository}:` : ""}{path}{line}</Text>
              {message ? <Text style={styles.reviewFindingMessage}>{message}</Text> : null}
              <View style={styles.reviewFindingFooter}>
                <MiniTag label={needsFix ? copy.reviewFindingNeedsFix : copy.reviewSeverityInfo} color={needsFix ? theme.colors.statusWarning : theme.colors.foregroundMuted} styles={styles} />
                {suggestion ? <Text style={styles.reviewFindingSuggestion}>{copy.reviewFindingSuggestion}: {suggestion}</Text> : null}
              </View>
            </View>
          </View>;
        })}
      </View>
    </View> : null}
    {checks.length ? <View style={styles.reviewDetailSection}>
      <Text style={styles.reviewDetailMeta}>{copy.reviewSettingsChecks}</Text>
      <View style={styles.reviewCheckList}>
        {checks.map((check, index) => {
          const status = check.status;
          const name = typeof check.name === "string" ? check.name : "";
          const evidence = typeof check.evidence === "string" ? check.evidence : "";
          return <View key={`${name}-${index}`} style={styles.reviewCheckRow}>
            <MiniTag label={checkStatusLabel(status, copy)} color={checkStatusColor(status, theme)} styles={styles} />
            <View style={styles.reviewFindingCopy}>
              <Text style={styles.reviewFindingMessage}>{name}</Text>
              {evidence ? <Text style={styles.reviewFindingSuggestion}>{copy.reviewCheckEvidence}: {evidence}</Text> : null}
            </View>
          </View>;
        })}
      </View>
    </View> : null}
    {criterionChecks.length ? <View style={styles.reviewDetailSection}>
      <Text style={styles.reviewDetailMeta}>{copy.handoffAcceptance}</Text>
      <View style={styles.reviewCheckList}>
        {criterionChecks.map((check, index) => <View key={`${String(check.id || "criterion")}-${index}`} style={styles.reviewCheckRow}>
          <MiniTag label={String(check.status || "not_verifiable")} color={check.status === "passed" ? theme.colors.statusSuccess : theme.colors.statusDanger} styles={styles} />
          <View style={styles.reviewFindingCopy}>
            <Text style={styles.reviewFindingMessage}>{String(check.id || "")}</Text>
            {typeof check.evidence === "string" && check.evidence ? <Text style={styles.reviewFindingSuggestion}>{copy.reviewCheckEvidence}: {check.evidence}</Text> : null}
          </View>
        </View>)}
      </View>
    </View> : null}
    {unreviewed.length ? <Text style={styles.reviewDetailMeta}>{copy.reviewUnreviewed}: {unreviewed.join(" · ")}</Text> : null}
    {changes.length ? <Text style={styles.reviewDetailMeta}>{copy.reviewChanges}: {changes.join(" · ")}</Text> : null}
    {tests.length ? <Text style={styles.reviewDetailMeta}>{copy.reviewTests}: {tests.join(" · ")}</Text> : null}
    {limitations.length ? <Text style={styles.reviewDetailMeta}>{copy.reviewKnownLimitations}: {limitations.join(" · ")}</Text> : null}
    {Object.keys(technical).length ? <Text selectable style={styles.reviewDetailText}>{JSON.stringify(technical, null, 2).slice(0, 1800)}</Text> : null}
  </View>;
}

function progressState(session: ReviewSession, index: number): "completed" | "active" | "pending" | "warning" {
  const status = session.status;
  const reviewerIndex = Math.min(3, Math.max(1, session.round) * 2 - 1);
  if (status === "approved") return index <= reviewerIndex ? "completed" : "pending";
  if (["failed", "blocked", "stopped", "limit_reached"].includes(status)) {
    if (status === "blocked" || status === "failed") return index < reviewerIndex ? "completed" : index === reviewerIndex ? "warning" : "pending";
    return index <= reviewerIndex ? "completed" : "pending";
  }
  if (status === "waiting_execution") return index === 0 ? "active" : "pending";
  if (["ready_for_review", "queued", "reviewing"].includes(status)) return index < reviewerIndex ? "completed" : index === reviewerIndex ? "active" : "pending";
  if (status === "changes_requested") return index < reviewerIndex ? "completed" : index === reviewerIndex ? "warning" : "pending";
  if (status === "fixing") return index < Math.min(2, reviewerIndex) ? "completed" : index === Math.min(2, reviewerIndex) ? "active" : "pending";
  if (status === "stopping") return index < reviewerIndex ? "completed" : index === reviewerIndex ? "active" : "pending";
  return index === 0 ? "active" : "pending";
}

function progressColor(state: ReturnType<typeof progressState>, theme: PanelProps["theme"]): string {
  if (state === "completed") return theme.colors.statusSuccess;
  if (state === "warning") return theme.colors.statusWarning;
  if (state === "active") return observerAccent(theme);
  return theme.colors.foregroundMuted;
}

function ReviewProgress({ session, copy, theme, styles }: { session: ReviewSession; copy: WorkbenchCopy; theme: PanelProps["theme"]; styles: ReturnType<typeof makeStyles> }) {
  const labels = [
    copy.reviewRoleExecution,
    `${copy.reviewRoleReviewer} · ${copy.reviewRoundShort.replace("{0}", "1")}`,
    copy.reviewRoleRepair,
    `${copy.reviewRoleReviewer} · ${copy.reviewRoundShort.replace("{0}", "2")}`,
  ];
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.reviewProgressScroll}>
    <View style={styles.reviewProgress}>
      {labels.map((label, index) => {
        const state = progressState(session, index);
        const color = progressColor(state, theme);
        return <React.Fragment key={label}>
          <View style={styles.reviewProgressStep}>
            <View style={[styles.reviewProgressNode, { borderColor: color, backgroundColor: state === "completed" ? color : theme.colors.surface1 }]}>
              {state === "completed" ? <Text style={[styles.reviewProgressNodeText, { color: theme.colors.accentForeground }]}>✓</Text> : <Text style={[styles.reviewProgressNodeText, { color }]}>{index + 1}</Text>}
            </View>
            <Text numberOfLines={2} style={[styles.reviewProgressLabel, { color }]}>{label}</Text>
          </View>
          {index < labels.length - 1 ? <View style={[styles.reviewProgressLine, { backgroundColor: state === "completed" ? theme.colors.statusSuccess : theme.colors.border }]} /> : null}
        </React.Fragment>;
      })}
    </View>
  </ScrollView>;
}

function ReviewBasis({ session, copy, styles }: { session: ReviewSession; copy: WorkbenchCopy; styles: ReturnType<typeof makeStyles> }) {
  const packet = session.handoff?.reviewPacket;
  if (!packet || (!packet.requirementUnderstanding && !packet.plan.length && !packet.acceptanceCriteria.length && !packet.references.length && !packet.instructions)) return null;
  const artifactStatus = new Map((session.snapshot?.artifacts || []).map((artifact) => [artifact.id, artifact.status]));
  return <View style={styles.reviewDetails}>
    <Text style={styles.reviewDetailMeta}>{copy.handoffPacket}</Text>
    {packet.requirementUnderstanding ? <Text selectable style={styles.reviewDetailText}>{packet.requirementUnderstanding}</Text> : null}
    {packet.plan.length ? <Text selectable style={styles.reviewDetailText}>{packet.plan.map((item, index) => `${index + 1}. ${item}`).join("\n")}</Text> : null}
    {packet.acceptanceCriteria.length ? <Text selectable style={styles.reviewDetailText}>{packet.acceptanceCriteria.map((item) => `${item.id}. ${item.text}`).join("\n")}</Text> : null}
    {packet.references.length ? <Text selectable style={styles.reviewDetailText}>{packet.references.map((item) => `${item.title || item.path || item.assetId || item.id} · ${item.path || (item.assetId ? `asset:${item.assetId}` : item.id)} · ${artifactStatus.get(item.id) || "pending"}`).join("\n")}</Text> : null}
    {packet.instructions ? <Text selectable style={styles.reviewDetailText}>{packet.instructions}</Text> : null}
  </View>;
}

function ReviewMessage({ event, session, copy, theme, styles, expanded, onToggle }: { event: ReviewEvent; session: ReviewSession; copy: WorkbenchCopy; theme: PanelProps["theme"]; styles: ReturnType<typeof makeStyles>; expanded: boolean; onToggle: () => void }) {
  const role = timelineRole(event.kind);
  const status = resultStatus(event);
  const hasDetails = eventHasDetails(event);
  const roleColor = role === "reviewer" ? observerAccent(theme) : role === "repair" ? theme.colors.statusWarning : role === "execution" ? theme.colors.statusSuccess : theme.colors.foregroundMuted;
  const title = roleLabel(role, copy);
  const eventRound = typeof event.details?.round === "number" && event.details.round > 0 ? event.details.round : session.round;
  const round = role === "reviewer" ? ` · ${copy.reviewRoundShort.replace("{0}", String(Math.max(1, eventRound)))}` : "";
  return <View style={[styles.reviewMessage, role === "system" && styles.reviewMessageSystem]}>
    <View style={[styles.reviewMessageAvatar, { backgroundColor: roleColor }]}><Text style={[styles.reviewMessageAvatarText, { color: theme.colors.accentForeground }]}>{role === "reviewer" ? "R" : role === "repair" ? "↻" : role === "execution" ? "E" : "•"}</Text></View>
    <View style={styles.reviewMessageContent}>
      <View style={styles.reviewMessageHeader}>
        <Text style={styles.reviewMessageRole}>{title}{round}</Text>
        {status ? <StatusPill status={status} label={statusLabel(status, copy)} theme={theme} styles={styles} /> : null}
        <Text style={styles.reviewEntryMeta}>{new Date(event.createdAt).toLocaleTimeString()}</Text>
      </View>
      <View style={styles.reviewMessageBody}>
        <Text numberOfLines={expanded ? undefined : 3} style={styles.reviewMessageText}>{eventBody(event, copy)}</Text>
        {hasDetails ? <Pressable accessibilityRole="button" onPress={onToggle} style={styles.reviewExpandButton}><Text style={styles.reviewExpandText}>{expanded ? copy.reviewCollapse : copy.reviewExpand}</Text></Pressable> : null}
        {expanded && hasDetails ? <ReviewDetails event={event} copy={copy} theme={theme} styles={styles} /> : null}
      </View>
    </View>
  </View>;
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
  onIndependent,
  readOnly = false,
  onSelectHistory,
  onOpenAgent,
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
  onIndependent?: () => void;
  readOnly?: boolean;
  onSelectHistory: (sessionId: string) => void;
  onOpenAgent?: (agentId: string) => void;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const copy = useWorkbenchCopy();
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const timelineEvents = React.useMemo(() => collapseReviewTimelineEvents(session?.events || []), [session?.events]);
  if (loading && !session) return <Text style={styles.emptyText}>{copy.reviewLoading}</Text>;
  if (!session) {
    return <View style={styles.reviewPanel}>
      <Text style={styles.sectionTitle}>{copy.reviewTitle}</Text>
      <Text style={styles.emptyText}>{copy.reviewNoFlow}</Text>
      <Pressable accessibilityRole="button" onPress={onStart} style={styles.secondaryButton}>
        <Text style={styles.secondaryButtonText}>{copy.reviewStart}</Text>
      </Pressable>
    </View>;
  }
  const active = ["queued", "reviewing", "fixing", "stopping"].includes(session.status);
  const canReview = session.status === "ready_for_review";
  const canManualStart = session.status === "waiting_execution";
  const canRepair = session.status === "changes_requested";
  const canResume = ["stopped", "failed", "blocked"].includes(session.status);
  const canStartNew = ["approved", "limit_reached"].includes(session.status);
  const result = session.latestResult;
  const conversationAgentId = session.reviewerAgentId || session.executionAgentId;
  const coordinatorTimedOut = session.status === "reviewing" && session.coordinator?.phase === "accepted" && Boolean(session.coordinator.timeoutAt);
  return <View style={styles.reviewPanel}>
    <View style={styles.reviewOverviewHeader}>
      <View style={styles.reviewOverviewTitle}>
        <Text style={styles.sectionTitle}>{copy.reviewTitle}</Text>
        <StatusPill status={session.status} label={statusLabel(session.status, copy)} theme={theme} styles={styles} />
      </View>
      <Text style={styles.reviewRoundText}>{copy.reviewRound.replace("{0}", String(Math.max(1, session.round))).replace("{1}", String(session.maxRounds))}</Text>
    </View>
    <Text style={styles.reviewEntryMeta}>{copy.reviewExecutionAgent} · {session.executionModelId || session.preferences.executionModel || copy.reviewSettingsFollowExecution}</Text>
    <Text style={styles.reviewEntryMeta}>{copy.reviewReviewer} · {session.reviewerModelId || session.preferences.reviewerModel || copy.reviewSettingsFollowExecution}</Text>
    <ReviewProgress session={session} copy={copy} theme={theme} styles={styles} />
    <ReviewBasis session={session} copy={copy} styles={styles} />
    {history.length > 1 ? <View style={styles.reviewHistoryRow}>
      <Text style={styles.reviewEntryMeta}>{copy.reviewHistory.replace("{0}", String(history.length))}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.briefActions}>{history.slice().reverse().map((item) => <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: item.id === session.id }} onPress={() => onSelectHistory(item.id)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{item.id.slice(0, 8)} · {statusLabel(item.status, copy)}</Text></Pressable>)}</ScrollView>
    </View> : null}
    {result ? <View style={styles.reviewResultBanner}>
      <View style={styles.reviewMessageHeader}><Text style={styles.reviewResultTitle}>{copy.reviewLatestResult}</Text><StatusPill status={result.verdict} label={statusLabel(result.verdict === "approved" ? "approved" : result.verdict === "changes_requested" ? "changes_requested" : "blocked", copy)} theme={theme} styles={styles} /></View>
      <Text numberOfLines={3} style={styles.reviewMessageText}>{result.summary}</Text>
      <View style={styles.reviewTagRow}>
        <MiniTag label={result.findings.length ? copy.reviewFindingCount.replace("{0}", String(result.findings.length)) : copy.reviewNoFindings} color={result.findings.length ? theme.colors.statusWarning : theme.colors.statusSuccess} styles={styles} />
        {result.checks.filter((check) => check.status === "passed").length ? <MiniTag label={`${copy.reviewCheckPassed} ${result.checks.filter((check) => check.status === "passed").length}`} color={theme.colors.statusSuccess} styles={styles} /> : null}
      </View>
    </View> : null}
    {session.status === "waiting_execution" && session.events.some((event) => event.kind === "resumed" && event.details?.phase === "waiting_execution") ? <Text style={styles.reviewEntryMeta}>{copy.reviewResumeWaitingReport}</Text> : null}
    {coordinatorTimedOut ? <View style={styles.reviewWarningBanner}><Text style={styles.warningText}>{copy.reviewCoordinatorTimeout}</Text></View> : null}
    {session.lastError ? <View style={session.status === "stopping" ? styles.reviewWarningBanner : styles.reviewErrorBanner}><Text style={styles.warningText}>{localizedReviewError(session.lastError, copy)}</Text><Text style={styles.reviewEntryMeta}>{copy.reviewErrorCodeLabel}: {session.lastError.code}</Text></View> : null}
    <View style={styles.reviewTimeline}>
      {timelineEvents.map((event) => {
        const open = Boolean(expanded[event.id]);
        return <ReviewMessage key={event.id} event={event} session={session} copy={copy} theme={theme} styles={styles} expanded={open} onToggle={() => setExpanded((current) => ({ ...current, [event.id]: !open }))} />;
      })}
    </View>
    <View style={styles.reviewActionBar}>
      {session.roundTarget === "coordinator" ? <Text style={styles.reviewEntryMeta}>{session.coordinator?.phase === "waiting" ? copy.reviewCoordinatorWaiting : session.coordinator?.phase === "uncertain" ? copy.reviewCoordinatorUncertain : session.coordinator?.phase === "sent" ? copy.reviewCoordinatorSent : session.coordinator?.phase === "stopping" ? copy.reviewCoordinatorStopping : copy.reviewCoordinator}{session.coordinator ? ` · ${session.coordinator.queuedAt}` : ""}</Text> : null}
      {onIndependent && session.roundTarget === "coordinator" && (session.coordinator?.phase === "waiting" || session.status === "stopped" || session.status === "ready_for_review") ? <Pressable accessibilityRole="button" onPress={onIndependent} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{copy.reviewIndependentSwitch}</Text></Pressable> : null}
      {session.coordinator?.agentId && onOpenAgent ? <Pressable accessibilityRole="button" onPress={() => onOpenAgent(session.coordinator!.agentId!)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{copy.reviewCoordinatorOpen}</Text></Pressable> : null}
      {canReview ? <Pressable accessibilityRole="button" onPress={onReview} style={styles.primaryReviewButton}><Text style={styles.primaryReviewButtonText}>{copy.reviewStart}</Text></Pressable> : null}
      {canManualStart ? <Pressable accessibilityRole="button" onPress={onStart} style={styles.primaryReviewButton}><Text style={styles.primaryReviewButtonText}>{copy.reviewStart}</Text></Pressable> : null}
      {canRepair && !readOnly ? <Pressable accessibilityRole="button" onPress={onRepair} style={styles.primaryReviewButton}><Text style={styles.primaryReviewButtonText}>{copy.reviewRepairAction}</Text></Pressable> : null}
      {active ? <Pressable accessibilityRole="button" onPress={onStop} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{copy.reviewStop}</Text></Pressable> : null}
      {canResume ? <Pressable accessibilityRole="button" onPress={onResume} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{copy.reviewResume}</Text></Pressable> : null}
      {canStartNew ? <Pressable accessibilityRole="button" onPress={onStart} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{copy.reviewStartNew}</Text></Pressable> : null}
      {conversationAgentId && onOpenAgent ? <Pressable accessibilityRole="button" onPress={() => onOpenAgent(conversationAgentId)} style={styles.reviewConversationButton}><Text style={styles.reviewConversationButtonText}>{copy.reviewViewConversation}</Text></Pressable> : null}
    </View>
  </View>;
}
