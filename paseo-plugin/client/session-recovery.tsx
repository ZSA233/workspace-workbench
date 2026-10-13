import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import type { PluginClientContext, PluginSurfaceProps, PluginButtonRegistration, PluginButtonContentProps } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "./native-components";
import { localeFromHostProps } from "./i18n";
import { resolveWorkbenchLocale } from "../shared/copy";
import { recoveryReasonLabel, recoveryStatusLabel, type RecoverySession } from "../shared/session-recovery";
import { RecoveryClientStore } from "./recovery-store";

const surfaceId = "workbench-session-recovery";
const activeStates = ["waiting", "paused", "sending", "running", "uncertain"];
function RecoveryPanel({ store, props, agentId, openAll }: { store: RecoveryClientStore; props: PluginSurfaceProps | PluginButtonContentProps; agentId?: string; openAll(): void }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const english = localeFromHostProps(props) === "en-US";
  const t = (zh: string, en: string) => english ? en : zh;
  const colors = props.theme.colors;
  const [search, setSearch] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const [interval, setIntervalValue] = useState(String(state.policy.intervalSeconds));
  const [duration, setDuration] = useState(String(state.policy.maxDurationMinutes ?? 60));
  const [unlimited, setUnlimited] = useState(state.policy.maxDurationMinutes === null);
  const [enabled, setEnabled] = useState(state.policy.enabled);
  const [method, setMethod] = useState(state.policy.method);
  const [continueMessage, setContinueMessage] = useState(state.policy.continueMessage);
  useEffect(() => {
    setIntervalValue(String(state.policy.intervalSeconds)); setDuration(String(state.policy.maxDurationMinutes ?? 60));
    setUnlimited(state.policy.maxDurationMinutes === null); setEnabled(state.policy.enabled);
    setMethod(state.policy.method); setContinueMessage(state.policy.continueMessage);
  }, [state.policy.intervalSeconds, state.policy.maxDurationMinutes, state.policy.enabled, state.policy.method, state.policy.continueMessage]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const run = (operation: () => Promise<unknown>) => {
    if (busy) return; setBusy(true); setError(null);
    void operation().catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
  };
  const button = (label: string, onPress: () => void, disabled = false, testID?: string) => <Pressable key={label} accessibilityRole="button" testID={testID} onPress={onPress} disabled={disabled || busy}
    style={{ paddingHorizontal: 10, paddingVertical: 8, minHeight: 36, borderWidth: 1, borderColor: colors.border, borderRadius: 6, opacity: disabled || busy ? 0.5 : 1 }}><Text style={{ color: colors.foreground }}>{label}</Text></Pressable>;
  const filtered = state.sessions.filter(s => (!agentId || s.agentId === agentId) && `${s.title} ${s.workspaceName} ${s.agentId}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const groups = new Map<string, { name: string; sessions: RecoverySession[] }>();
  for (const session of filtered) {
    const key = session.workspaceId || session.workspaceName;
    if (!groups.has(key)) groups.set(key, { name: session.workspaceName, sessions: [] });
    groups.get(key)!.sessions.push(session);
  }
  const inputStyle = { color: colors.foreground, backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: 6, padding: 9 };
  return <View testID="session-recovery-panel" style={{ flex: agentId ? undefined : 1, maxHeight: agentId ? 560 : undefined, padding: 16, backgroundColor: colors.surface0, gap: 12 }}>
    <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 18, fontWeight: "600" }}>{t("会话自动恢复", "Session auto recovery")}</Text>
    <Text style={{ color: colors.foregroundMuted }}>{t("覆盖此 Paseo 服务的所有 Codex 会话；无需接入 Workbench 项目。", "Covers every Codex session on this Paseo service, including sessions outside Workbench projects.")}</Text>
    {!state.available ? <Text testID="recovery-unavailable" style={{ color: colors.statusWarning }}>{state.loaded ? t("恢复服务暂不可用", "Recovery service unavailable") : t("正在读取恢复状态…", "Loading recovery status…")}</Text> : null}
    {error || state.error ? <Text selectable style={{ color: colors.statusWarning }}>{error || recoveryReasonLabel(state.error!, english)}</Text> : null}
    {state.available ? <Text testID="recovery-effective-method" style={{ color: colors.foregroundMuted }}>{state.policy.method === "auto" && state.nativeAvailable
      ? t("当前方式：原生恢复，不增加消息。", "Current method: native recovery without adding a message.")
      : state.policy.method === "auto"
        ? t("原生接口不可用，当前使用继续消息恢复；无需打补丁。", "Native recovery is unavailable. Continue messages are available without a host patch.")
        : t("当前方式：发送继续消息，无需安装宿主补丁。", "Current method: send a continue message; no host patch required.")}</Text> : null}
    <ScrollView contentContainerStyle={{ gap: 12 }}>
      {!agentId ? <View style={{ gap: 10, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}><Text style={{ color: colors.foreground }}>{t("默认开启自动恢复", "Enable auto recovery by default")}</Text><Switch testID="recovery-global-enabled" value={enabled} onValueChange={setEnabled} disabled={busy || !state.available} /></View>
        <Text style={{ color: colors.foreground }}>{t("恢复方式", "Recovery method")}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {button(`${method === "continue" ? "✓ " : ""}${t("发送继续消息（默认）", "Send continue message (default)")}`, () => setMethod("continue"), !state.available, "recovery-method-continue")}
          {button(`${method === "auto" ? "✓ " : ""}${t("优先原生，缺失时发送继续", "Prefer native, fall back to continue")}`, () => setMethod("auto"), !state.available, "recovery-method-auto")}
        </View>
        <Text style={{ color: colors.foreground }}>{t("继续消息", "Continue message")}</Text>
        <TextInput testID="recovery-continue-message" accessibilityLabel={t("继续消息", "Continue message")} value={continueMessage} onChangeText={setContinueMessage} maxLength={2000} style={inputStyle} />
        <Text style={{ color: colors.foregroundMuted }}>{t("消息方式会在原会话发送这句话，默认只有“继续”，不会附加系统说明。", "Message recovery sends this text in the original session. The default is just “继续”, with no extra instructions.")}</Text>
        <Text style={{ color: colors.foreground }}>{t("重试间隔（秒）", "Retry interval (seconds)")}</Text>
        <TextInput testID="recovery-interval" accessibilityLabel={t("重试间隔（秒）", "Retry interval (seconds)")} keyboardType="numeric" value={interval} onChangeText={setIntervalValue} style={inputStyle} />
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}><Text style={{ color: colors.foreground }}>{t("持续重试直到手动停止", "Retry until manually stopped")}</Text><Switch testID="recovery-unlimited" value={unlimited} onValueChange={setUnlimited} disabled={busy || !state.available} /></View>
        {!unlimited ? <><Text style={{ color: colors.foreground }}>{t("最长持续时间（分钟）", "Maximum duration (minutes)")}</Text><TextInput testID="recovery-duration" accessibilityLabel={t("最长持续时间（分钟）", "Maximum duration (minutes)")} keyboardType="numeric" value={duration} onChangeText={setDuration} style={inputStyle} /></> : null}
        {button(t("保存设置", "Save settings"), () => {
          if (!continueMessage.trim()) { setError(t("继续消息不能为空。", "The continue message cannot be empty.")); return; }
          if (!Number.isInteger(Number(interval)) || Number(interval) < 1 || Number(interval) > 3600 || (!unlimited && (!Number.isInteger(Number(duration)) || Number(duration) < 1 || Number(duration) > 10080))) {
            setError(t("间隔需为 1～3600 的整数秒；最长时间需为 1～10080 的整数分钟。", "Use 1–3600 whole seconds for the interval and 1–10080 whole minutes for the duration.")); return;
          }
          run(() => store.savePolicy({ enabled, method, continueMessage: continueMessage.trim(), intervalSeconds: Number(interval), maxDurationMinutes: unlimited ? null : Number(duration) }));
        }, !state.available, "recovery-save")}
        <Text style={{ color: colors.foregroundMuted }}>{t("设置立即生效；关闭自动恢复会撤销等待中的恢复，不中断已运行的 Agent。", "Changes apply immediately. Disabling recovery cancels pending retries without interrupting running agents.")}</Text>
      </View> : null}
      {!agentId ? <TextInput testID="recovery-search" accessibilityLabel={t("搜索会话", "Search sessions")} placeholder={t("搜索会话、Workspace 或 ID…", "Search sessions, workspaces or IDs…")} value={search} onChangeText={setSearch} style={inputStyle} /> : null}
      {[...groups].map(([workspace, { name, sessions }]) => <View key={workspace} style={{ gap: 8 }}>
        {!agentId ? <Text accessibilityRole="header" style={{ color: colors.foregroundMuted, fontWeight: "600" }}>{name} · {workspace.slice(0, 8)}</Text> : null}
        {sessions.map(session => <View key={session.agentId} testID={`recovery-session-${session.agentId}`} style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}>
          <Text selectable style={{ color: colors.foreground, fontWeight: "600" }}>{session.title}</Text>
          <Text style={{ color: ["uncertain", "paused", "stopped"].includes(session.status) ? colors.statusWarning : colors.foreground }}>{recoveryStatusLabel(session, english)}</Text>
          <Text style={{ color: colors.foregroundMuted }}>{session.deliveryKind === "native" ? t("恢复方式：原生恢复", "Recovery method: native") : t("恢复方式：继续消息", "Recovery method: continue message")}</Text>
          <Text style={{ color: colors.foregroundMuted }}>{session.agentId.slice(0, 8)} · {session.role || (session.connectedToWorkbench ? t("Workbench 工具已接入", "Workbench tools connected") : t("普通 Codex 会话", "Codex session"))} · {session.override === null ? t("跟随全局设置", "Using global settings") : t("会话独立设置", "Session override")}</Text>
          {session.nextAttemptAt !== null ? <Text testID="recovery-countdown" style={{ color: colors.foregroundMuted }}>{t("下次尝试：", "Next attempt: ")}{Math.max(0, Math.ceil((session.nextAttemptAt - now) / 1000))}{t(" 秒后", " seconds")}</Text> : null}
          {session.deadlineAt !== null && activeStates.includes(session.status) ? <Text style={{ color: colors.foregroundMuted }}>{t("剩余恢复时间：", "Recovery time remaining: ")}{Math.max(0, Math.ceil((session.deadlineAt - now) / 60000))}{t(" 分钟", " minutes")}</Text> : null}
          {session.reason ? <Text selectable style={{ color: colors.foregroundMuted }}>{recoveryReasonLabel(session.reason, english)}</Text> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {button(session.enabled ? t("关闭此会话自动恢复", "Disable for this session") : t("开启此会话自动恢复", "Enable for this session"), () => run(() => store.action({ action: "setEnabled", agentId: session.agentId, enabled: !session.enabled })), !state.available)}
            {session.override !== null ? button(t("跟随全局", "Use global setting"), () => run(() => store.action({ action: "setEnabled", agentId: session.agentId, enabled: null })), !state.available) : null}
            {activeStates.includes(session.status) ? button(t("停止本次恢复", "Stop this recovery"), () => run(() => store.action({ action: "cancel", agentId: session.agentId })), !state.available) : null}
            {session.status === "waiting" ? button(session.deliveryKind === "native" ? t("立即重试", "Retry now") : t("立即继续", "Continue now"), () => run(() => store.action({ action: "retryNow", agentId: session.agentId })), !state.available) : null}
            {"navigation" in props && props.navigation?.openAgent ? button(t("打开会话", "Open session"), () => props.navigation?.openAgent({ agentId: session.agentId })) : null}
          </View>
        </View>)}
      </View>)}
      {state.loaded && !filtered.length ? <Text style={{ color: colors.foregroundMuted }}>{t("没有匹配的 Codex 会话", "No matching Codex sessions")}</Text> : null}
      {agentId ? button(t("全部会话与设置", "All sessions and settings"), openAll) : null}
    </ScrollView>
  </View>;
}

export function registerRecoveryClient(client: PluginClientContext): () => void {
  const store = new RecoveryClientStore(client), pills = new Map<string, { button: PluginButtonRegistration; label: string; workspaceId: string }>();
  const english = resolveWorkbenchLocale() === "en-US";
  const openAll = () => client.openSurface(surfaceId);
  const removeSurface = client.addSurface(surfaceId, props => <RecoveryPanel store={store} props={props} openAll={openAll} />);
  const removeSidebar = client.addSidebarItem({ id: "workbench-session-recovery", title: english ? "Session auto recovery" : "会话自动恢复", icon: "RotateCw", surface: surfaceId });
  const removeSettings = client.addSettingsScreen({ id: "workbench-session-recovery-settings", title: english ? "Session auto recovery" : "会话自动恢复", icon: "RotateCw", Component: props => <RecoveryPanel store={store} props={props} openAll={openAll} /> });
  const unsubscribe = store.subscribe(() => {
    const sessions = store.getSnapshot().sessions, current = new Set(sessions.map(s => s.agentId));
    for (const [id, pill] of pills) if (!current.has(id)) { pill.button.remove(); pills.delete(id); }
    for (const session of sessions) {
      if (!session.workspaceId) continue;
      const label = recoveryStatusLabel(session, english);
      const existing = pills.get(session.agentId);
      if (existing?.workspaceId === session.workspaceId) {
        if (existing.label !== label) { existing.button.update({ label, title: label }); existing.label = label; }
        continue;
      }
      existing?.button.remove();
      try {
        pills.set(session.agentId, { label, workspaceId: session.workspaceId, button: client.addComposerPill({ id: "workbench-session-recovery", workspaceId: session.workspaceId, agentId: session.agentId,
          button: { title: label, label, icon: "RotateCw", behavior: { kind: "popover", Content: props => <RecoveryPanel store={store} props={props} agentId={session.agentId} openAll={openAll} /> } } }) });
      } catch { /* Hosts lacking a pill slot retain the global status screen. */ }
    }
  });
  store.start();
  return () => { unsubscribe(); store.close(); pills.forEach(pill => pill.button.remove()); pills.clear(); removeSettings(); removeSidebar(); removeSurface(); };
}
