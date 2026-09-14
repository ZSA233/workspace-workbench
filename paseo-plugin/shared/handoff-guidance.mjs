export const coordinatorGuidance = "The coordinator plans, delegates and reviews. Workspace implementation and tests belong to the execution worker. After successful workspace_execute, report the handoff and end this turn. Send later supplements through workbench_session_message; do not implement the delegated plan yourself.";
export const handoffCompleteGuidance = "执行会话已接手。请告知交接结果并结束本轮；后续补充使用 workbench_session_message，不要自行实施或重复执行计划。";
export function handoffOutcome(result) {
  return result?.ok ? { ...result, nextAction: "end_turn", instructions: handoffCompleteGuidance }
    : { ...result, nextAction: "check_status", instructions: "Check the existing handoff status; do not recreate or implement the task when delivery is uncertain." };
}
