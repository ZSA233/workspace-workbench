import { useRpc } from '@getpaseo/plugin/client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentRelationship } from '../shared/agent-session';
import { artifactList } from '../shared/artifacts';
import { localizedReviewError, type WorkbenchCopy, type WorkbenchLocale } from '../shared/copy';
import { agentContextQuery, workspaceBindingQuery, workspaceDelegate, workspaceHandoffPreview, type AgentContextResponse, type Handoff, type WorkspaceBindingResponse, type WorkspaceDelegateResponse } from '../shared/handoff';
import type { ReviewPacket } from '../shared/review-packet';
import { queryErrorMessage } from './components/ui';
import { useToast } from './native-components';
function nonEmptyLines(value: string): string[] {
    return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
function referenceKind(path: string): "file" | "document" | "prototype" | "image" | "pdf" {
    const lower = path.toLowerCase();
    if (/\.(png|jpe?g|webp|gif)$/.test(lower))
        return "image";
    if (lower.endsWith(".pdf"))
        return "pdf";
    if (/\.(md|markdown|txt|json|html?)$/.test(lower))
        return "document";
    return "file";
}
function reviewPacketFromEditor(input: {
    understanding: string;
    plan: string;
    acceptance: string;
    references: string;
    instructions: string;
}): ReviewPacket {
    const acceptanceCriteria = nonEmptyLines(input.acceptance).map((text, index) => ({ id: `AC-${index + 1}`, text, required: true }));
    const references = nonEmptyLines(input.references).map((value, index) => {
        if (value.startsWith("asset:")) {
            const assetId = value.slice("asset:".length).trim();
            return { id: `REF-${index + 1}`, kind: "image" as const, title: assetId || `Asset ${index + 1}`, assetId, required: true };
        }
        const separator = value.indexOf(":");
        const hasRepositoryPrefix = separator > 0 && !value.startsWith("./") && !value.startsWith("../") && !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value);
        const repositoryId = hasRepositoryPrefix ? value.slice(0, separator).trim() : undefined;
        const path = hasRepositoryPrefix ? value.slice(separator + 1).trim() : value;
        return { id: `REF-${index + 1}`, kind: referenceKind(path), title: path, required: true, ...(repositoryId ? { repositoryId } : {}), path };
    }).filter((reference) => Boolean(reference.assetId || ("path" in reference && reference.path)));
    return {
        requirementUnderstanding: input.understanding.trim(),
        plan: nonEmptyLines(input.plan),
        acceptanceCriteria,
        references,
        instructions: input.instructions.trim(),
    };
}
export function appendAssetReference(current: string, assetId: string): string {
    const line = `asset:${assetId}`;
    if (nonEmptyLines(current).some((value) => value === line))
        return current;
    return current.trim() ? `${current.trim()}\n${line}` : line;
}
export function useWorkspaceHandoff({ projectConfig, selectedWorkspaceId, foreground, listReady, selectedWorkspaceIsMain, selectedWorkspaceBlocksTasks, agentCapability, agentId, locale, localizedCopy }: {
    projectConfig: string;
    selectedWorkspaceId: string;
    foreground: boolean;
    listReady: boolean;
    selectedWorkspaceIsMain: boolean;
    selectedWorkspaceBlocksTasks: boolean;
    agentCapability: boolean;
    agentId?: string;
    locale: WorkbenchLocale;
    localizedCopy: WorkbenchCopy;
}) {
    const toast = useToast();
    const rawBindingRpc = useRpc(workspaceBindingQuery);
    const bindingRpc = (input: Parameters<typeof rawBindingRpc>[0]) => rawBindingRpc({ ...input, projectConfig });
    const rawDelegateRpc = useRpc(workspaceDelegate);
    const delegateRpc = (input: Parameters<typeof rawDelegateRpc>[0]) => rawDelegateRpc({ ...input, projectConfig });
    const artifactListRpc = useRpc(artifactList);
    const [handoffGoal, setHandoffGoal] = useState("");
    const [handoffRelationship, setHandoffRelationship] = useState<"default" | AgentRelationship>("default");
    const [handoffPacketOpen, setHandoffPacketOpen] = useState(false);
    const [handoffPreviewOpen, setHandoffPreviewOpen] = useState(false);
    const previewHandoffRpc = useRpc(workspaceHandoffPreview);
    const handoffPreviewEpoch = useRef(0);
    const [materialPreview, setMaterialPreview] = useState<{
        ok: boolean;
        signature: string;
        materials?: {
            ready: boolean;
            sourceCount: number;
            blockers: string[];
            warnings: string[];
            conversation: {
                state: string;
            };
        } | null;
    } | null>(null);
    const [handoffUnderstanding, setHandoffUnderstanding] = useState("");
    const [handoffPlan, setHandoffPlan] = useState("");
    const [handoffAcceptance, setHandoffAcceptance] = useState("");
    const [handoffReferences, setHandoffReferences] = useState("");
    const [handoffReviewInstructions, setHandoffReviewInstructions] = useState("");
    const [workerStartMode, setWorkerStartMode] = useState<"adaptive" | "plan-first">("adaptive");
    const [delegating, setDelegating] = useState(false);
    const parentAgentId = agentId || null;
    const rawAgentContextRpc = useRpc(agentContextQuery);
    const agentContextRpc = (input: Parameters<typeof rawAgentContextRpc>[0]) => rawAgentContextRpc(input);
    const agentContextQueryState = useQuery({
        queryKey: ["workspace-workbench", projectConfig, "agent-context", parentAgentId],
        queryFn: () => agentContextRpc({ projectConfig, agentId: parentAgentId! }),
        enabled: foreground && Boolean(parentAgentId && listReady),
        refetchInterval: false,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 5000,
    });
    const agentContext = agentContextQueryState.data as AgentContextResponse | undefined;
    const agentContextAvailable = Boolean(agentContext?.ok && agentContext.available);
    const agentContextState: "ready" | "loading" | "unavailable" | "missing" = !parentAgentId
        ? "missing"
        : agentContextQueryState.isPending
            ? "loading"
            : agentContextAvailable
                ? "ready"
                : "unavailable";
    const bindingQuery = useQuery({
        queryKey: ["workspace-workbench", projectConfig, "execution-binding", selectedWorkspaceId],
        queryFn: () => bindingRpc({ workspaceId: selectedWorkspaceId }),
        enabled: foreground && Boolean(selectedWorkspaceId && listReady && !selectedWorkspaceIsMain && agentCapability),
        refetchInterval: false,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 1000,
    });
    const binding = (bindingQuery.data?.binding || null) as WorkspaceBindingResponse["binding"];
    const savedHandoff = bindingQuery.data?.handoff || null;
    const artifactListQuery = useQuery({
        queryKey: ["workspace-workbench", projectConfig, "handoff-artifacts"],
        queryFn: () => artifactListRpc({ projectConfig }),
        enabled: Boolean(projectConfig && handoffPacketOpen),
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 5000,
    });
    const boundAgent = (bindingQuery.data?.agent || null) as WorkspaceBindingResponse["agent"];
    const bindingFailure = bindingQuery.data?.error?.message || queryErrorMessage(bindingQuery.error, localizedCopy);
    useEffect(() => {
        setHandoffGoal("");
        setHandoffRelationship("default");
        setHandoffPacketOpen(false);
        setHandoffPreviewOpen(false);
        handoffPreviewEpoch.current++;
        setMaterialPreview(null);
        setHandoffUnderstanding("");
        setHandoffPlan("");
        setHandoffAcceptance("");
        setHandoffReferences("");
        setHandoffReviewInstructions("");
    }, [projectConfig, selectedWorkspaceId]);
    function buildSelectedHandoff(): Handoff | null {
        const goal = handoffGoal.trim();
        if (!selectedWorkspaceId || (!savedHandoff && !goal && !binding?.agentId))
            return null;
        if (savedHandoff)
            return savedHandoff;
        return {
            version: "workspace.workbench.handoff/v1",
            goal: goal || localizedCopy.text_36cdf2a07a,
            decisions: [],
            inScope: [],
            outOfScope: [],
            steps: [],
            acceptance: [],
            constraints: [],
            ambiguities: [],
            reviewPacket: reviewPacketFromEditor({
                understanding: handoffUnderstanding,
                plan: handoffPlan,
                acceptance: handoffAcceptance,
                references: handoffReferences,
                instructions: handoffReviewInstructions,
            }),
            startMode: workerStartMode,
            reviewLocale: locale,
            ...(handoffRelationship === "default" ? {} : { relationship: handoffRelationship }),
            policy: { placementGuard: true },
            expected: { branchByRepository: {}, baseByRepository: {} },
        };
    }
    async function delegateSelectedWorkspace(): Promise<void> {
        if (selectedWorkspaceBlocksTasks) {
            toast.show(localizedCopy.workspaceDeleteQueued, { variant: "warning" });
            return;
        }
        if (selectedWorkspaceIsMain) {
            toast.show(localizedCopy.text_bb57803d41, { variant: "warning" });
            return;
        }
        if (!selectedWorkspaceId || !parentAgentId) {
            toast.show(localizedCopy.text_d7dd46e5e3, { variant: "warning" });
            return;
        }
        if (!buildSelectedHandoff()) {
            toast.show(localizedCopy.text_afa9beb681, { variant: "warning" });
            return;
        }
        setHandoffPreviewOpen(true);
        setMaterialPreview(null);
        const epoch = ++handoffPreviewEpoch.current;
        const handoff = buildSelectedHandoff()!;
        try {
            const response = await previewHandoffRpc({ projectConfig, workspaceId: selectedWorkspaceId, parentAgentId, handoff }) as Omit<NonNullable<typeof materialPreview>, "signature">;
            if (epoch === handoffPreviewEpoch.current)
                setMaterialPreview({ ...response, signature: JSON.stringify(handoff) });
        }
        catch {
            if (epoch === handoffPreviewEpoch.current)
                toast.error(localizedCopy.handoffMaterialsUnavailable);
        }
    }
    async function submitSelectedWorkspace(): Promise<void> {
        const handoff = buildSelectedHandoff();
        if (!handoff || !selectedWorkspaceId || !parentAgentId)
            return;
        if (!materialPreview?.ok || materialPreview.materials?.ready === false || materialPreview.signature !== JSON.stringify(handoff))
            return;
        setDelegating(true);
        const epoch = handoffPreviewEpoch.current;
        try {
            const result: WorkspaceDelegateResponse = await delegateRpc({
                workspaceId: selectedWorkspaceId,
                parentAgentId,
                handoff,
            });
            if (result.ok) {
                const actionLabel = result.action === "created"
                    ? localizedCopy.text_a2eb60ef6c
                    : result.action === "already-running"
                        ? localizedCopy.text_0561f1d18e
                        : result.action === "reused"
                            ? localizedCopy.text_050246dd54
                            : localizedCopy.text_962c002fa2;
                toast.show(actionLabel, { variant: "success" });
                if (epoch === handoffPreviewEpoch.current)
                    setHandoffPreviewOpen(false);
            }
            else {
                toast.show(result.error ? localizedReviewError(result.error, localizedCopy) : localizedCopy.text_b4f57a0af8, { variant: result.action === "blocked" ? "warning" : "error" });
            }
            await bindingQuery.refetch().catch(() => undefined);
        }
        catch (error) {
            toast.show(error instanceof Error ? error.message : localizedCopy.text_341baadc12, { variant: "error" });
        }
        finally {
            setDelegating(false);
        }
    }
    const draftHandoff = buildSelectedHandoff();
    const draftPacket = draftHandoff?.reviewPacket || null;
    const handoffAssetOptions = useMemo(() => (artifactListQuery.data?.artifacts || []).filter((artifact) => artifact.kind === "image" || artifact.mimeType.startsWith("image/")), [artifactListQuery.data?.artifacts]);
    return { handoffGoal, setHandoffGoal, handoffRelationship, setHandoffRelationship, handoffPacketOpen, setHandoffPacketOpen, handoffPreviewOpen, setHandoffPreviewOpen, materialPreview, handoffUnderstanding, setHandoffUnderstanding, handoffPlan, setHandoffPlan, handoffAcceptance, setHandoffAcceptance, handoffReferences, setHandoffReferences, handoffReviewInstructions, setHandoffReviewInstructions, workerStartMode, setWorkerStartMode, delegating, parentAgentId, agentContextAvailable, agentContextState, bindingQuery, binding, boundAgent, bindingFailure, draftHandoff, draftPacket, handoffAssetOptions, delegateSelectedWorkspace, submitSelectedWorkspace };
}
