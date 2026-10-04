import { useRpc } from '@getpaseo/plugin/client';
import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { Platform } from 'react-native';
import { clientDiagnostic } from '../shared/client-diagnostics';
import { openFileReview } from './file-review-store';
import type { ChangeScope, FileChange, RepositorySummary, WorkspaceSummary } from './model';
export function useFileView({ projectConfig, hostWorkspaceId, agentId, selectedWorkspace, selectedRepository, selectedRepoPath, selectedCommit, changesScope, graphView, setGraphView, graphQuery, graphLoadedCount, animateSectionLayout, setSelectedCommit, setSelectedFile, setSelectedRepoPath, setRepositoryDetailsOpen }: {
    projectConfig: string;
    hostWorkspaceId: string;
    agentId?: string;
    selectedWorkspace?: WorkspaceSummary;
    selectedRepository?: RepositorySummary;
    selectedRepoPath: string;
    selectedCommit: string;
    changesScope: ChangeScope;
    graphView: {
        historyMode: 'branch' | 'full';
        maxCommits: number;
    };
    setGraphView: Dispatch<SetStateAction<{
        historyMode: 'branch' | 'full';
        maxCommits: number;
    }>>;
    graphQuery: {
        refetch: () => Promise<unknown>;
        isFetching: boolean;
    };
    graphLoadedCount: number;
    animateSectionLayout: () => void;
    setSelectedCommit: (sha: string) => void;
    setSelectedFile: (path: string) => void;
    setSelectedRepoPath: (path: string) => void;
    setRepositoryDetailsOpen: Dispatch<SetStateAction<boolean>>;
}) {
    const sendFileDiagnostic = useRpc(clientDiagnostic);
    const onCommit = useCallback((sha: string) => {
        setSelectedCommit(sha);
        setSelectedFile("");
    }, []);
    const onGraphBase = useCallback(() => setGraphView((current) => ({ ...current, historyMode: "full", maxCommits: 50 })), []);
    const graphRefetch = graphQuery.refetch;
    const graphFetching = graphQuery.isFetching;
    const onGraphMore = useCallback(() => {
        if (graphFetching)
            return;
        const next = Math.min(graphLoadedCount + 50, 200);
        if (next <= graphView.maxCommits) {
            void graphRefetch();
            return;
        }
        setGraphView((current) => ({ ...current, maxCommits: next }));
    }, [graphFetching, graphLoadedCount, graphRefetch, graphView.maxCommits]);
    const onOpenChangedFile = useCallback((file: FileChange) => {
        void sendFileDiagnostic({ phase: "file-read-row-click", platform: Platform.OS, details: { repositoryReady: String(Boolean(selectedRepository)), workspaceReady: String(Boolean(selectedWorkspace)), at: String(Date.now()) } }).catch(() => { });
        if (!selectedRepository || !selectedWorkspace)
            return;
        setSelectedFile(file.path);
        openFileReview({
            projectConfig,
            workspaceId: selectedWorkspace.id,
            repoPath: selectedRepository.repoPath,
            path: file.path,
            oldPath: file.oldPath,
            scope: changesScope,
            commitSha: selectedCommit || undefined,
            branch: selectedRepository.branch,
            baseSha: selectedRepository.baseSha,
            head: selectedRepository.head,
            status: file.status,
            statusLabel: file.statusLabel,
        }, {
            hostWorkspaceId,
            directory: selectedWorkspace.treePath || selectedWorkspace.sourceRoot,
            panelId: agentId ? "workspace-workbench-file-agent" : "workspace-workbench-file",
            agentId,
        });
    }, [agentId, changesScope, hostWorkspaceId, projectConfig, selectedCommit, selectedRepository, selectedWorkspace, sendFileDiagnostic]);
    const onRepo = useCallback((repoPath: string) => {
        animateSectionLayout();
        const changingRepository = selectedRepoPath !== repoPath;
        setSelectedRepoPath(repoPath);
        setSelectedFile("");
        setRepositoryDetailsOpen(changingRepository ? true : (current) => !current);
    }, [animateSectionLayout, selectedRepoPath]);
    return { onCommit, onGraphBase, onGraphMore, onOpenChangedFile, onRepo };
}
