import { createHash } from "node:crypto";

const shortReads = new Set([
  "workbench_connection_status", "workbench_session_status", "workbench_session_history",
  "workbench_review_status",
]);
const mutations = new Set([
  "workbench_workspace_preview", "workbench_workspace_submit", "workbench_workspace_create",
  "workbench_workspace_delegate", "workbench_workspace_add_repositories",
  "workbench_session_message", "workbench_session_stop", "workbench_review_read",
  "workbench_review_result", "workbench_artifact_register", "workbench_workspace_execute",
  "workbench_review_execute", "workbench_review_stop", "workbench_review_resume",
  "workbench_reviewer_result", "workbench_execution_report",
]);

export function isMutation(name) { return mutations.has(name); }
export function requestBudget(message, fullBudget = 55_000) {
  return message?.method === "tools/call" && shortReads.has(message?.params?.name)
    ? Math.min(fullBudget, 6_000) : fullBudget;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function stableRequestId(kind, projectConfig, args) {
  const input = { ...args };
  delete input.requestId;
  const hash = createHash("sha256").update(JSON.stringify(canonical({ kind, projectConfig, input }))).digest("hex").slice(0, 32);
  return `workbench-${kind}-${hash}`;
}
