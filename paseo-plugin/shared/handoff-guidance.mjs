export const coordinatorGuidance = "The coordinator may submit an authorized task with workbench_workspace_submit using a concise task statement and original document paths. The worker reads accessible originals and inspects the repositories; do not mechanically duplicate conversation history, MIME metadata, decisions, or rejected alternatives. Use preview/execute only when a separate preview boundary is useful. After a successful handoff, report it and end this turn. Send later supplements through workbench_session_message.";
export const handoffCompleteGuidance = "执行会话已接手。请告知交接结果并结束本轮；后续补充使用 workbench_session_message，不要自行实施或重复执行计划。";
export function handoffOutcome(result) {
  return result?.ok ? { ...result, nextAction: "end_turn", instructions: handoffCompleteGuidance }
    : { ...result, nextAction: "check_status", instructions: "Check the existing handoff status; do not recreate or implement the task when delivery is uncertain." };
}
