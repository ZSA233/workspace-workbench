/**
 * Review subsystem entrypoint.
 *
 * The plugin entrypoint imports this façade rather than reaching into the
 * legacy review state machine. The exported boundary keeps persistence,
 * snapshot, runner and recovery code replaceable without changing RPC
 * registration or old schema-v2 records.
 */
export {
  handleExecutionReportRpc,
  handleCoordinatorReview,
  handleReviewModels,
  handleReviewPreview,
  handleReviewSessionControl,
  handleReviewSessionEvents,
  handleReviewSessionList,
  handleReviewSessionQuery,
  handleReviewSessionStart,
  handleReviewSettingsGet,
  handleReviewSettingsUpdate,
  handleReviewerReadRpc,
  handleReviewerResultRpc,
  registerReviewLifecycle,
} from "../agent-review.ts";

export function reviewLifecycleEnabled(): boolean {
  return process.env.WORKBENCH_ENABLE_REVIEW_LIFECYCLE === "1";
}
