import {useCallback,useRef} from 'react';
import {useQuery} from '@tanstack/react-query';
import {useRpc} from '@getpaseo/plugin/client';
import {useToast} from './native-components';
import {reviewSessionQuery,reviewSessionList,reviewSessionStart,reviewSessionControl,type ReviewSession} from '../shared/agent-review';
import {localizedReviewError,type WorkbenchCopy,type WorkbenchLocale} from '../shared/copy';

export function useReviewSession({projectConfig,selectedWorkspaceId,reviewSessionId,foreground,backendReady,listReady,selectedWorkspaceIsMain,boundAgentId,locale,mainReviewInstructions,localizedCopy,onStarted}:{
 projectConfig:string;selectedWorkspaceId:string;reviewSessionId:string;foreground:boolean;backendReady:boolean;listReady:boolean;
 selectedWorkspaceIsMain:boolean;boundAgentId?:string;locale:WorkbenchLocale;mainReviewInstructions:string;localizedCopy:WorkbenchCopy;onStarted:()=>void;
}) {
 const toast=useToast();
 const currentWorkspace=useRef(selectedWorkspaceId);currentWorkspace.current=selectedWorkspaceId;
  const reviewSessionRpc = useRpc(reviewSessionQuery);
  const reviewSessionListRpc = useRpc(reviewSessionList);
  const reviewStartRpc = useRpc(reviewSessionStart);
  const reviewControlRpc = useRpc(reviewSessionControl);
  const agentReviewQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "agent-review", selectedWorkspaceId, reviewSessionId],
    queryFn: () => reviewSessionRpc({ projectConfig, workspaceId: selectedWorkspaceId, ...(reviewSessionId ? { sessionId: reviewSessionId } : {}) }),
    enabled: foreground && Boolean(selectedWorkspaceId && backendReady && listReady), refetchInterval: false, refetchOnWindowFocus: false, retry: false,
  });
  const agentReviewHistoryQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "agent-review-history", selectedWorkspaceId],
    queryFn: () => reviewSessionListRpc({ projectConfig, workspaceId: selectedWorkspaceId }),
    enabled: foreground && Boolean(selectedWorkspaceId && backendReady && listReady), refetchInterval: false, refetchOnWindowFocus: false, retry: false,
  });
  const agentReview = (agentReviewQuery.data?.session || null) as ReviewSession | null;
  const startAgentReview = useCallback(() => {
    if (!selectedWorkspaceId) return;
    void reviewStartRpc({ projectConfig, workspaceId: selectedWorkspaceId, executionAgentId: selectedWorkspaceIsMain ? undefined : boundAgentId, locale, ...(selectedWorkspaceIsMain && mainReviewInstructions.trim() ? { instructions: mainReviewInstructions.trim() } : {}) }).then((result) => {
      if (!result.ok) toast.error(localizedReviewError(result.error, localizedCopy));
      else if(currentWorkspace.current===selectedWorkspaceId) onStarted();
      return agentReviewQuery.refetch();
    }).catch(() => toast.error(localizedCopy.reviewErrorGeneric));
  }, [agentReviewQuery, boundAgentId, locale, localizedCopy, mainReviewInstructions, projectConfig, reviewStartRpc, onStarted, selectedWorkspaceId, selectedWorkspaceIsMain, toast]);
  const controlAgentReview = useCallback((action: "stop" | "resume" | "review" | "repair" | "independent") => {
    if (!selectedWorkspaceId || !agentReview) return;
    void reviewControlRpc({ projectConfig, workspaceId: selectedWorkspaceId, sessionId: agentReview.id, action }).then((result) => {
      if (!result.ok) toast.error(localizedReviewError(result.error, localizedCopy));
      return agentReviewQuery.refetch();
    }).catch(() => toast.error(localizedCopy.reviewErrorGeneric));
  }, [agentReview, agentReviewQuery, localizedCopy, projectConfig, reviewControlRpc, selectedWorkspaceId, toast]);

return {agentReviewQuery,agentReviewHistoryQuery,agentReview,startAgentReview,controlAgentReview};
}
