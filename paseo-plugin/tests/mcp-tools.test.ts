import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// A test launched from an execution/reviewer session must not inherit that
// session's MCP role. Each case explicitly selects its own role below.
const mcpEnv = { ...process.env };
delete mcpEnv.WORKBENCH_REVIEW_ONLY;
delete mcpEnv.WORKBENCH_EXECUTION_REPORT_ONLY;

test("MCP exposes only the public Workbench tool names with compact schemas", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../mcp.mjs", import.meta.url))], {
    encoding: "utf8",
    env: mcpEnv,
    input: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n',
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim()) as { result: { tools: Array<{ name: string; description: string; inputSchema: { required: string[] } }> } };
  assert.deepEqual(response.result.tools.map((tool) => tool.name), [
    "workbench_handoff_read", "workbench_handoff_search", "workbench_handoff_asset",
    "workbench_session_status", "workbench_session_message", "workbench_session_history", "workbench_session_wait", "workbench_session_stop", "workbench_review_read", "workbench_review_result",
    "workbench_artifact_register",
    "workbench_workspace_preview",
    "workbench_workspace_execute",
    "workbench_workspace_status",
    "workbench_workspace_submit",
    "workbench_review_preview",
    "workbench_review_execute",
    "workbench_review_status",
    "workbench_review_stop",
    "workbench_review_resume",
  ]);
  const preview = response.result.tools.find((tool) => tool.name === "workbench_workspace_preview")!;
  const execute = response.result.tools.find((tool) => tool.name === "workbench_workspace_execute")!;
  const status = response.result.tools.find((tool) => tool.name === "workbench_workspace_status")!;
  assert.match(preview.description, /without Git changes/);
  assert.match(preview.description, /canonical request/);
  assert.match(execute.description, /requestId alone/);
  assert.match(status.description, /request ID/);
  for (const tool of response.result.tools) {
    assert.ok(tool.description.length < 180);
    if (tool.name === "workbench_artifact_register") assert.deepEqual(tool.inputSchema.required, ["artifact"]);
    if (tool.name === "workbench_workspace_preview") assert.deepEqual(tool.inputSchema.required, ["requestId", "handoff"]);
    if (tool.name === "workbench_workspace_execute") assert.deepEqual(tool.inputSchema.required, ["requestId"]);
    if (tool.name === "workbench_workspace_status") assert.deepEqual(tool.inputSchema.required, ["requestId"]);
    if (tool.name === "workbench_workspace_submit") assert.deepEqual(tool.inputSchema.required, ["task"]);
    if (["workbench_review_preview", "workbench_review_status", "workbench_review_stop", "workbench_review_resume"].includes(tool.name)) assert.deepEqual(tool.inputSchema.required, ["workspaceId"]);
    if (tool.name === "workbench_review_execute") assert.deepEqual(tool.inputSchema.required, ["workspaceId", "action"]);
  }
});

test("review and execution MCP processes expose only their role tools", () => {
  const input = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n';
  const reviewer = spawnSync(process.execPath, [fileURLToPath(new URL("../mcp.mjs", import.meta.url))], { encoding: "utf8", input, env: { ...mcpEnv, WORKBENCH_REVIEW_ONLY: "1" } });
  assert.equal(reviewer.status, 0, reviewer.stderr);
  assert.deepEqual(JSON.parse(reviewer.stdout.trim()).result.tools.map((tool: { name: string }) => tool.name), ["workbench_reviewer_read", "workbench_reviewer_result", "workbench_handoff_read", "workbench_handoff_search", "workbench_handoff_asset"]);
  const execution = spawnSync(process.execPath, [fileURLToPath(new URL("../mcp.mjs", import.meta.url))], { encoding: "utf8", input, env: { ...mcpEnv, WORKBENCH_EXECUTION_REPORT_ONLY: "1" } });
  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(JSON.parse(execution.stdout.trim()).result.tools.map((tool: { name: string }) => tool.name), ["workbench_execution_report", "workbench_handoff_read", "workbench_handoff_search", "workbench_handoff_asset"]);
});

test("MCP initialization gives coordinator guidance only to interactive sessions", () => {
  for (const role of ["interactive", "WORKBENCH_REVIEW_ONLY", "WORKBENCH_EXECUTION_REPORT_ONLY"]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../mcp.mjs", import.meta.url))], {
      encoding: "utf8", timeout: 10_000,
      env: { ...mcpEnv, ...(role === "interactive" ? {} : { [role]: "1" }) },
      input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n",
    });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout.trim()).result;
    assert.equal(response.protocolVersion, "2024-11-05");
    if (role === "interactive") assert.match(response.instructions, /end this turn/);
    else assert.equal(response.instructions, undefined);
  }
});
