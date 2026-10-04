import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRpc } from '@getpaseo/plugin/client';
import { useToast } from './native-components';
import type { WorkbenchCopy } from '../shared/copy';
import { reviewSettingsGet, reviewSettingsUpdate, reviewModels, type ReviewPreferencePatch, type ReviewModelOverride } from '../shared/agent-review';
import { agentSessionSettingsGet, agentSessionSettingsUpdate, agentSessionProviders, type AgentRelationship, type AgentPermissionMode, type AgentSessionPatch } from '../shared/agent-session';
import { localizedReviewError } from '../shared/copy';

export function useWorkbenchSettings({projectConfig,selectedWorkspaceId,foreground,backendReady,listReady,localizedCopy,boundAgentProvider,refreshAgentReview,closeOtherMenus}:{
  projectConfig:string;selectedWorkspaceId:string;foreground:boolean;backendReady:boolean;listReady:boolean;
  localizedCopy:WorkbenchCopy;boundAgentProvider?:string;refreshAgentReview:()=>Promise<unknown>;closeOtherMenus:()=>void;
}) {
  const toast=useToast();
  const [reviewSettingsOpen, setReviewSettingsOpen] = useState(false);
  const [reviewSettingsScope, setReviewSettingsScope] = useState<"project" | "global">("project");
  const [reviewMode, setReviewMode] = useState<"off" | "manual" | "automatic">("off");
  const [autoFix, setAutoFix] = useState(false);
  const [maxRounds, setMaxRounds] = useState("3");
  const [reviewerTimeoutMinutes, setReviewerTimeoutMinutes] = useState("15");
  const [repairTimeoutMinutes, setRepairTimeoutMinutes] = useState("30");
  const [reviewerRole, setReviewerRole] = useState("");
  const [reviewInstructions, setReviewInstructions] = useState("");
  const [reviewerSession, setReviewerSession] = useState<"reuse" | "new_per_round">("reuse");
  const [reviewerTarget, setReviewerTarget] = useState<"coordinator" | "independent">("independent");
  const [executionModel, setExecutionModel] = useState("");
  const [reviewerModel, setReviewerModel] = useState("");
  const reviewDirtyFields = useRef(new Set<string>());
  const sessionDirtyFields = useRef(new Set<string>());
  const [sessionDefaultRelationship, setSessionDefaultRelationship] = useState<AgentRelationship>("independent");
  const [sessionPermissionMode, setSessionPermissionMode] = useState<AgentPermissionMode>("inherit");
  const [sessionProviderRelationships, setSessionProviderRelationships] = useState<Record<string, AgentRelationship>>({});
  const markReviewField = useCallback((field: string) => { reviewDirtyFields.current.add(field); }, []);
  const markSessionField = useCallback((field: string) => { sessionDirtyFields.current.add(field); }, []);
  const reviewSettingsGetRpc = useRpc(reviewSettingsGet);
  const reviewSettingsUpdateRpc = useRpc(reviewSettingsUpdate);
  const reviewModelsRpc = useRpc(reviewModels);
  const agentSessionSettingsGetRpc = useRpc(agentSessionSettingsGet);
  const agentSessionSettingsUpdateRpc = useRpc(agentSessionSettingsUpdate);
  const agentSessionProvidersRpc = useRpc(agentSessionProviders);
  const reviewSettingsQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "agent-review-settings"],
    queryFn: () => reviewSettingsGetRpc({ projectConfig }),
    enabled: Boolean(projectConfig), refetchOnWindowFocus: false, retry: false,
  });
  const agentSessionSettingsQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "agent-session-settings"],
    queryFn: () => agentSessionSettingsGetRpc({ projectConfig }),
    enabled: Boolean(projectConfig), refetchOnWindowFocus: false, retry: false,
  });
  const agentSessionProvidersQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "agent-session-providers"],
    queryFn: () => agentSessionProvidersRpc({ projectConfig }),
    enabled: Boolean(projectConfig), staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: false,
  });
  const reviewModelsQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "agent-review-models", selectedWorkspaceId],
    queryFn: () => reviewModelsRpc({ projectConfig, workspaceId: selectedWorkspaceId }),
    enabled: Boolean(foreground && reviewSettingsOpen && projectConfig && backendReady && selectedWorkspaceId && listReady), staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: false,
  });
  const reviewPreferences = reviewSettingsQuery.data?.effective;
  const agentSessionPreferences = agentSessionSettingsQuery.data?.effective;
  const syncReviewEditor = useCallback(() => {
    if (reviewPreferences) {
      reviewDirtyFields.current.clear();
      setReviewMode(reviewPreferences.mode);
      setAutoFix(reviewPreferences.autoFix);
      setMaxRounds(String(reviewPreferences.maxRounds));
      setReviewerTimeoutMinutes(String(Math.max(1, Math.round(reviewPreferences.reviewerTimeoutMs / 60_000))));
      setRepairTimeoutMinutes(String(Math.max(1, Math.round(reviewPreferences.repairTimeoutMs / 60_000))));
      const builtInRole = reviewPreferences.reviewerRole === "Code reviewer" || reviewPreferences.reviewerRole === "代码审核者";
      const builtInInstructions = reviewPreferences.instructions === "Check requirement fit, correctness, regressions and tests; keep the implementation simple."
        || reviewPreferences.instructions === "检查需求是否满足、实现是否正确、是否引入回归、测试是否充分；保持实现简单。";
      setReviewerRole(builtInRole ? localizedCopy.reviewDefaultRole : reviewPreferences.reviewerRole);
      setReviewInstructions(builtInInstructions ? localizedCopy.reviewDefaultInstructions : reviewPreferences.instructions);
      setReviewerSession(reviewPreferences.reviewerSession);
      setReviewerTarget(reviewPreferences.reviewerTarget);
      setExecutionModel(reviewPreferences.executionModel || "");
      setReviewerModel(reviewPreferences.reviewerModel || "");
    }
    if (agentSessionPreferences) {
      sessionDirtyFields.current.clear();
      const sessionPatch = reviewSettingsScope === "project"
        ? agentSessionSettingsQuery.data?.project
        : agentSessionSettingsQuery.data?.global;
      setSessionDefaultRelationship(sessionPatch?.defaultRelationship || agentSessionPreferences.defaultRelationship);
      setSessionPermissionMode(sessionPatch?.permissionMode || agentSessionPreferences.permissionMode);
      setSessionProviderRelationships(sessionPatch?.providerRelationships || {});
    }
  }, [agentSessionPreferences, agentSessionSettingsQuery.data?.global, agentSessionSettingsQuery.data?.project, localizedCopy, reviewPreferences, reviewSettingsScope]);
  useEffect(() => { syncReviewEditor(); }, [syncReviewEditor]);
  const saveReviewSettings = useCallback(async () => {
    try {
      const dirty = reviewDirtyFields.current;
      const shared: ReviewPreferencePatch = {};
      if (dirty.has("mode")) shared.mode = reviewMode;
      if (dirty.has("autoFix")) shared.autoFix = autoFix;
      if (dirty.has("maxRounds")) shared.maxRounds = Number(maxRounds) || 3;
      if (dirty.has("reviewerTimeoutMs")) shared.reviewerTimeoutMs = Math.max(1, Number(reviewerTimeoutMinutes) || 15) * 60_000;
      if (dirty.has("repairTimeoutMs")) shared.repairTimeoutMs = Math.max(1, Number(repairTimeoutMinutes) || 30) * 60_000;
      if (dirty.has("reviewerRole")) shared.reviewerRole = reviewerRole.trim() || localizedCopy.reviewDefaultRole;
      if (dirty.has("instructions")) shared.instructions = reviewInstructions;
      if (dirty.has("reviewerSession")) shared.reviewerSession = reviewerSession;
      if (dirty.has("reviewerTarget")) shared.reviewerTarget = reviewerTarget;
      const models: ReviewModelOverride = {};
      const modelReset: string[] = [];
      if (dirty.has("executionModel")) executionModel.trim() ? models.executionModel = executionModel.trim() : modelReset.push("executionModel");
      if (dirty.has("reviewerModel")) reviewerModel.trim() ? models.reviewerModel = reviewerModel.trim() : modelReset.push("reviewerModel");
      const sessionPatch: AgentSessionPatch = {};
      if (sessionDirtyFields.current.has("defaultRelationship")) sessionPatch.defaultRelationship = sessionDefaultRelationship;
      if (sessionDirtyFields.current.has("permissionMode")) sessionPatch.permissionMode = sessionPermissionMode;
      if (sessionDirtyFields.current.has("providerRelationships")) sessionPatch.providerRelationships = sessionProviderRelationships;
      if (reviewSettingsScope === "project") {
        if (Object.keys(shared).length) await reviewSettingsUpdateRpc({ projectConfig, scope: "project", patch: shared, resetFields: [] });
        if (Object.keys(models).length || modelReset.length) await reviewSettingsUpdateRpc({ projectConfig, scope: "project-model", patch: models, resetFields: modelReset });
      } else if (Object.keys(shared).length || Object.keys(models).length || modelReset.length) {
        await reviewSettingsUpdateRpc({ projectConfig, scope: "global", patch: { ...shared, ...models }, resetFields: modelReset });
      }
      if (Object.keys(sessionPatch).length) await agentSessionSettingsUpdateRpc({ projectConfig, scope: reviewSettingsScope, patch: sessionPatch, resetFields: [] });
      reviewDirtyFields.current.clear();
      sessionDirtyFields.current.clear();
      setReviewSettingsOpen(false);
      await reviewSettingsQuery.refetch();
      await agentSessionSettingsQuery.refetch();
      await refreshAgentReview();
    } catch (error) {
      toast.error(localizedReviewError(error instanceof Error ? { code: error.message } : null, localizedCopy, localizedCopy.reviewSettingsSaveFailed));
    }
  }, [refreshAgentReview, agentSessionSettingsQuery, agentSessionSettingsUpdateRpc, autoFix, executionModel, localizedCopy, maxRounds, projectConfig, repairTimeoutMinutes, reviewInstructions, reviewerModel, reviewerRole, reviewerSession, reviewerTarget, reviewerTimeoutMinutes, reviewMode, reviewSettingsQuery, reviewSettingsScope, reviewSettingsUpdateRpc, sessionDefaultRelationship, sessionPermissionMode, sessionProviderRelationships, toast]);
  const closeReviewSettings = useCallback(() => {
    syncReviewEditor();
    setReviewSettingsOpen(false);
  }, [syncReviewEditor]);
  const openReviewSettings = useCallback(() => {
    closeOtherMenus();
    syncReviewEditor();
    setReviewSettingsOpen(true);
  }, [closeOtherMenus, syncReviewEditor]);
  const resetReviewField = useCallback((field: string) => {
    const modelField = field === "executionModel" || field === "reviewerModel";
    void reviewSettingsUpdateRpc({ projectConfig, scope: reviewSettingsScope === "global" ? "global" : modelField ? "project-model" : "project", patch: {}, resetFields: [field] }).then(() => {
      reviewDirtyFields.current.clear();
      return reviewSettingsQuery.refetch();
    }).catch((error) => toast.error(localizedReviewError(error instanceof Error ? { code: error.message } : null, localizedCopy, localizedCopy.reviewSettingsSaveFailed)));
  }, [localizedCopy, projectConfig, reviewSettingsQuery, reviewSettingsScope, reviewSettingsUpdateRpc, toast]);
  const resetAllProjectReviewOverrides = useCallback(async () => {
    try {
      await reviewSettingsUpdateRpc({ projectConfig, scope: "project", patch: {}, resetFields: ["mode", "autoFix", "maxRounds", "reviewerRole", "instructions", "reviewerSession", "reviewerTarget", "reviewerTimeoutMs", "repairTimeoutMs"] });
      await reviewSettingsUpdateRpc({ projectConfig, scope: "project-model", patch: {}, resetFields: ["executionModel", "reviewerModel"] });
      await agentSessionSettingsUpdateRpc({ projectConfig, scope: "project", patch: {}, resetFields: ["defaultRelationship", "permissionMode", "providerRelationships"] });
      reviewDirtyFields.current.clear();
      sessionDirtyFields.current.clear();
      await reviewSettingsQuery.refetch();
      await refreshAgentReview();
      await agentSessionSettingsQuery.refetch();
    } catch (error) {
      toast.error(localizedReviewError(error instanceof Error ? { code: error.message } : null, localizedCopy, localizedCopy.reviewSettingsSaveFailed));
    }
  }, [refreshAgentReview, agentSessionSettingsQuery, agentSessionSettingsUpdateRpc, localizedCopy, projectConfig, reviewSettingsQuery, reviewSettingsUpdateRpc, toast]);
  const reviewSources = reviewSettingsQuery.data?.sources || {};
  const reviewProject = reviewSettingsQuery.data?.project || {};
  const reviewGlobal = reviewSettingsQuery.data?.global || {};
  const reviewProjectModels = reviewSettingsQuery.data?.models || {};
  const sessionSources = agentSessionSettingsQuery.data?.sources;
  const sessionProviders = useMemo(() => {
    const values = new Set((agentSessionProvidersQuery.data?.providers || []).map((item) => item.provider));
    const current = boundAgentProvider?.split("/")[0];
    if (current) values.add(current);
    return [...values].sort();
  }, [agentSessionProvidersQuery.data?.providers, boundAgentProvider]);
  const sourceLabel = (field: string) => {
    const source = reviewSources[field];
    return source === "project" || source === "project-model" ? localizedCopy.reviewSourceProject : source === "global" || source === "global-model" ? localizedCopy.reviewSourceGlobal : localizedCopy.reviewSourceDefault;
  };
  const hasReviewOverride = (field: string) => {
    const source = reviewSettingsScope === "project"
      ? field === "executionModel" || field === "reviewerModel" ? reviewProjectModels : reviewProject
      : reviewGlobal;
    return Object.prototype.hasOwnProperty.call(source, field);
  };
  const sessionSourceLabel = (field: string) => {
    if (field === "defaultRelationship") {
      const source = sessionSources?.defaultRelationship;
      return source === "project" ? localizedCopy.reviewSourceProject : source === "global" ? localizedCopy.reviewSourceGlobal : localizedCopy.reviewSourceDefaultShort;
    }
    if (field === "permissionMode") {
      const source = sessionSources?.permissionMode;
      return source === "project" ? localizedCopy.reviewSourceProject : source === "global" ? localizedCopy.reviewSourceGlobal : localizedCopy.reviewSourceDefaultShort;
    }
    const source = sessionSources?.providerRelationships?.[field];
    return source === "project" ? localizedCopy.reviewSourceProject : source === "global" ? localizedCopy.reviewSourceGlobal : localizedCopy.reviewSourceDefaultShort;
  };
  const sessionPermissionLabel = (mode: AgentPermissionMode) => mode === "inherit"
    ? localizedCopy.agentSessionPermissionInherit
    : mode === "auto"
      ? localizedCopy.agentSessionPermissionAuto
      : mode === "auto-review"
        ? localizedCopy.agentSessionPermissionAutoReview
        : localizedCopy.agentSessionPermissionFullAccess;

  return { reviewSettingsOpen, setReviewSettingsOpen, reviewSettingsScope, setReviewSettingsScope, reviewMode, setReviewMode, autoFix, setAutoFix, maxRounds, setMaxRounds, reviewerTimeoutMinutes, setReviewerTimeoutMinutes, repairTimeoutMinutes, setRepairTimeoutMinutes, reviewerRole, setReviewerRole, reviewInstructions, setReviewInstructions, reviewerSession, setReviewerSession, reviewerTarget, setReviewerTarget, executionModel, setExecutionModel, reviewerModel, setReviewerModel, reviewDirtyFields, sessionDefaultRelationship, setSessionDefaultRelationship, sessionPermissionMode, setSessionPermissionMode, sessionProviderRelationships, setSessionProviderRelationships, markReviewField, markSessionField, reviewModelsQuery, saveReviewSettings, closeReviewSettings, openReviewSettings, resetReviewField, resetAllProjectReviewOverrides, sessionProviders, sourceLabel, hasReviewOverride, sessionSourceLabel, sessionPermissionLabel };
}
