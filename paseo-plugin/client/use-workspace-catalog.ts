import { useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useToast } from './native-components';
import { resultOf } from './components/ui';
import type { ObserverMethod, ObserverResponse } from '../shared/observer';
import type { WorkbenchCopy } from '../shared/copy';
type MainRepositorySelection = {
    revision: number;
    sourceRoot: string;
    scan?: {
        incomplete: boolean;
        reason?: "directory_limit" | "entry_limit" | "time_limit" | "cancelled";
        scannedDirectories: number;
    };
    repositories: Array<{
        id: string;
        name: string;
        path: string;
        configured: boolean;
        exists: boolean;
        missing: boolean;
        selected: boolean;
    }>;
};
type LinkedWorkspaceSelection = {
    revision: number;
    scan?: {
        incomplete: boolean;
    };
    repositories: Array<{
        path: string;
        name: string;
        selected: boolean;
        missing?: boolean;
        links?: Array<{
            path: string;
        }>;
    }>;
};
type OrphanPreview = {
    id: string;
    treePath: string;
    eligible: boolean;
    fingerprint: string;
    repositories: Array<{
        id: string;
        repoPath: string;
        sourcePath: string;
        configured?: boolean;
        worktreePath: string;
        head: string;
        branch: string | null;
        dirty: boolean;
        dirtyPaths: string[];
    }>;
    issues: Array<{
        code: string;
        message: string;
        path?: string;
    }>;
    warnings?: Array<{
        code: string;
        message: string;
        path?: string;
    }>;
    plannedBranches?: Record<string, string>;
    resume?: boolean;
};
export function useWorkspaceCatalog({ projectConfig, backendReady, rpc, localizedCopy, refreshArea, onAdopted }: {
    projectConfig: string;
    backendReady: boolean;
    rpc: (input: {
        method: ObserverMethod;
        params: Record<string, unknown>;
    }) => Promise<ObserverResponse>;
    localizedCopy: WorkbenchCopy;
    refreshArea: (kind: string) => Promise<unknown>;
    onAdopted: (id: string) => void;
}) {
    const toast = useToast();
    const [mainRepositoriesOpen, setMainRepositoriesOpen] = useState(false);
    const [mainRepositoryFilter, setMainRepositoryFilter] = useState("");
    const [mainRepositoryDraft, setMainRepositoryDraft] = useState<string[]>([]);
    const [savingMainRepositories, setSavingMainRepositories] = useState(false);
    const [linkedWorkspacesOpen, setLinkedWorkspacesOpen] = useState(false);
    const [linkedWorkspaceFilter, setLinkedWorkspaceFilter] = useState("");
    const [linkedWorkspaceDraft, setLinkedWorkspaceDraft] = useState<string[]>([]);
    const [savingLinkedWorkspaces, setSavingLinkedWorkspaces] = useState(false);
    const [orphanId, setOrphanId] = useState("");
    const [orphanBranches, setOrphanBranches] = useState<Record<string, string>>({});
    const [adoptingOrphan, setAdoptingOrphan] = useState(false);
    const [orphanError, setOrphanError] = useState("");
    const orphanPreviewQuery = useQuery({
        queryKey: ["workspace-workbench", projectConfig, "orphan-preview", orphanId],
        queryFn: () => rpc({ method: "workspace.orphan.preview", params: { workspaceId: orphanId } }),
        enabled: Boolean(projectConfig && backendReady && orphanId), retry: false, staleTime: 0, refetchOnWindowFocus: false,
    });
    const orphanPreview = resultOf<OrphanPreview>(orphanPreviewQuery.data);
    useEffect(() => { setOrphanBranches(orphanPreview?.plannedBranches || {}); setOrphanError(""); }, [orphanId, orphanPreview?.fingerprint]);
    const mainRepositoriesQuery = useQuery({
        queryKey: ["workspace-workbench", projectConfig, "main-repositories"],
        queryFn: () => rpc({ method: "main.repositories.list", params: {} }),
        enabled: Boolean(projectConfig && backendReady && mainRepositoriesOpen),
        retry: false,
        staleTime: 0,
    });
    const mainRepositories = resultOf<MainRepositorySelection>(mainRepositoriesQuery.data);
    useEffect(() => {
        if (mainRepositories)
            setMainRepositoryDraft(mainRepositories.repositories.filter(repo => repo.selected).map(repo => repo.path));
    }, [mainRepositories?.revision]);
    const linkedWorkspacesQuery = useQuery({
        queryKey: ["workspace-workbench", projectConfig, "linked-workspaces"],
        queryFn: () => rpc({ method: "linked.workspaces.list", params: {} }),
        enabled: Boolean(projectConfig && backendReady && linkedWorkspacesOpen), retry: false, staleTime: 0,
    });
    const linkedWorkspaces = resultOf<LinkedWorkspaceSelection>(linkedWorkspacesQuery.data);
    useEffect(() => {
        if (linkedWorkspaces)
            setLinkedWorkspaceDraft(linkedWorkspaces.repositories.filter(item => item.selected).map(item => item.path));
    }, [linkedWorkspaces?.revision]);
    const saveMainRepositories = useCallback(async () => {
        if (!mainRepositories || savingMainRepositories)
            return;
        setSavingMainRepositories(true);
        try {
            const response = await rpc({ method: "main.repositories.save", params: { revision: mainRepositories.revision, repositories: mainRepositoryDraft } });
            if (!response.ok)
                throw new Error(response.error?.message || localizedCopy.mainRepositorySaveFailed);
            await Promise.allSettled([refreshArea("workspace-list"), refreshArea("workspace-detail"), mainRepositoriesQuery.refetch()]);
            setMainRepositoriesOpen(false);
        }
        catch (error) {
            toast.error(error instanceof Error ? error.message : localizedCopy.mainRepositorySaveFailed);
        }
        finally {
            setSavingMainRepositories(false);
        }
    }, [refreshArea, localizedCopy.mainRepositorySaveFailed, mainRepositories, mainRepositoriesQuery.refetch, mainRepositoryDraft, rpc, savingMainRepositories, toast]);
    const saveLinkedWorkspaces = useCallback(async () => {
        if (!linkedWorkspaces || savingLinkedWorkspaces)
            return;
        setSavingLinkedWorkspaces(true);
        try {
            const response = await rpc({ method: "linked.workspaces.save", params: { revision: linkedWorkspaces.revision, repositories: linkedWorkspaceDraft } });
            if (!response.ok)
                throw new Error(response.error?.message || localizedCopy.linkedWorkspaceSaveFailed);
            await Promise.allSettled([refreshArea("workspace-list"), linkedWorkspacesQuery.refetch()]);
            setLinkedWorkspacesOpen(false);
        }
        catch (error) {
            toast.error(error instanceof Error ? error.message : localizedCopy.linkedWorkspaceSaveFailed);
        }
        finally {
            setSavingLinkedWorkspaces(false);
        }
    }, [linkedWorkspaces, savingLinkedWorkspaces, linkedWorkspaceDraft, rpc, localizedCopy.linkedWorkspaceSaveFailed, refreshArea, linkedWorkspacesQuery.refetch, toast]);
    const adoptSelectedOrphan = async () => {
        if (!orphanPreview?.eligible || adoptingOrphan)
            return;
        setAdoptingOrphan(true);
        setOrphanError("");
        try {
            const response = await rpc({ method: "workspace.orphan.adopt", params: {
                    workspaceId: orphanPreview.id, fingerprint: orphanPreview.fingerprint, branches: orphanBranches,
                } });
            if (!response.ok)
                throw new Error(response.error?.message || localizedCopy.orphanCannotAdopt);
            const adoptedId = orphanPreview.id;
            await refreshArea("workspace-list");
            onAdopted(adoptedId);
            setOrphanId("");
        }
        catch (error) {
            setOrphanError(error instanceof Error ? error.message : String(error));
        }
        finally {
            setAdoptingOrphan(false);
        }
    };
    return { mainRepositoriesOpen, setMainRepositoriesOpen, mainRepositoryFilter, setMainRepositoryFilter, mainRepositoryDraft, setMainRepositoryDraft, savingMainRepositories, linkedWorkspacesOpen, setLinkedWorkspacesOpen, linkedWorkspaceFilter, setLinkedWorkspaceFilter, linkedWorkspaceDraft, setLinkedWorkspaceDraft, savingLinkedWorkspaces, orphanId, setOrphanId, orphanBranches, setOrphanBranches, adoptingOrphan, orphanError, orphanPreviewQuery, orphanPreview, mainRepositoriesQuery, mainRepositories, linkedWorkspacesQuery, linkedWorkspaces, saveMainRepositories, saveLinkedWorkspaces, adoptSelectedOrphan };
}
