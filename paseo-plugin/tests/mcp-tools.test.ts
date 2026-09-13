import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("MCP exposes only the public Workbench tool names with compact schemas", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../mcp.mjs", import.meta.url))], {
    encoding: "utf8",
    input: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n',
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim()) as { result: { tools: Array<{ name: string; description: string; inputSchema: { required: string[] } }> } };
  assert.deepEqual(response.result.tools.map((tool) => tool.name), [
    "workbench_artifact_register",
    "workbench_workspace_preview",
    "workbench_workspace_execute",
    "workbench_workspace_status",
    "workbench_review_preview",
    "workbench_review_execute",
    "workbench_review_status",
    "workbench_review_stop",
    "workbench_review_resume",
  ]);
  for (const tool of response.result.tools) {
    assert.ok(tool.description.length < 70);
    if (tool.name === "workbench_artifact_register") assert.deepEqual(tool.inputSchema.required, ["artifact"]);
    if (["workbench_workspace_preview", "workbench_workspace_execute"].includes(tool.name)) assert.deepEqual(tool.inputSchema.required, ["requestId", "handoff"]);
    if (tool.name === "workbench_workspace_status") assert.deepEqual(tool.inputSchema.required, ["requestId"]);
    if (["workbench_review_preview", "workbench_review_status", "workbench_review_stop", "workbench_review_resume"].includes(tool.name)) assert.deepEqual(tool.inputSchema.required, ["workspaceId"]);
    if (tool.name === "workbench_review_execute") assert.deepEqual(tool.inputSchema.required, ["workspaceId", "action"]);
  }
});

test("review and execution MCP processes expose only their role tools", () => {
  const input = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n';
  const reviewer = spawnSync(process.execPath, [fileURLToPath(new URL("../mcp.mjs", import.meta.url))], { encoding: "utf8", input, env: { ...process.env, WORKBENCH_REVIEW_ONLY: "1" } });
  assert.equal(reviewer.status, 0, reviewer.stderr);
  assert.deepEqual(JSON.parse(reviewer.stdout.trim()).result.tools.map((tool: { name: string }) => tool.name), ["workbench_reviewer_read", "workbench_reviewer_result"]);
  const execution = spawnSync(process.execPath, [fileURLToPath(new URL("../mcp.mjs", import.meta.url))], { encoding: "utf8", input, env: { ...process.env, WORKBENCH_EXECUTION_REPORT_ONLY: "1" } });
  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(JSON.parse(execution.stdout.trim()).result.tools.map((tool: { name: string }) => tool.name), ["workbench_execution_report"]);
});
