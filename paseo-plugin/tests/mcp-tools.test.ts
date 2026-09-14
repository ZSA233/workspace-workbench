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
  const preview = response.result.tools.find((tool) => tool.name === "workbench_workspace_preview")!;
  const execute = response.result.tools.find((tool) => tool.name === "workbench_workspace_execute")!;
  assert.match(preview.description, /Plan mode allows preview only/);
  assert.match(execute.description, /approval and leaving Plan mode/);
  for (const tool of response.result.tools) {
    const workspaceAction = ["workbench_workspace_preview", "workbench_workspace_execute"].includes(tool.name);
    assert.ok(tool.description.length < (workspaceAction ? 220 : 70));
    if (tool.name === "workbench_artifact_register") assert.deepEqual(tool.inputSchema.required, ["artifact"]);
    if (["workbench_workspace_preview", "workbench_workspace_execute"].includes(tool.name)) assert.deepEqual(tool.inputSchema.required, ["requestId", "handoff"]);
    if (tool.name === "workbench_workspace_status") assert.deepEqual(tool.inputSchema.required, ["requestId"]);
    if (["workbench_review_preview", "workbench_review_status", "workbench_review_stop", "workbench_review_resume"].includes(tool.name)) assert.deepEqual(tool.inputSchema.required, ["workspaceId"]);
    if (tool.name === "workbench_review_execute") assert.deepEqual(tool.inputSchema.required, ["workspaceId", "action"]);
  }
});

test("review and execution MCP processes expose only their role tools", () => {
  const input = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n';
  const reviewer = spawnSync(process.execPath, [fileURLToPath(new URL("../mcp.mjs", import.meta.url))], { encoding: "utf8", input, env: { ...mcpEnv, WORKBENCH_REVIEW_ONLY: "1" } });
  assert.equal(reviewer.status, 0, reviewer.stderr);
  assert.deepEqual(JSON.parse(reviewer.stdout.trim()).result.tools.map((tool: { name: string }) => tool.name), ["workbench_reviewer_read", "workbench_reviewer_result"]);
  const execution = spawnSync(process.execPath, [fileURLToPath(new URL("../mcp.mjs", import.meta.url))], { encoding: "utf8", input, env: { ...mcpEnv, WORKBENCH_EXECUTION_REPORT_ONLY: "1" } });
  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(JSON.parse(execution.stdout.trim()).result.tools.map((tool: { name: string }) => tool.name), ["workbench_execution_report"]);
});

test("MCP initialization delivers orchestration guidance only to interactive agents", () => {
  for (const role of ["interactive", "WORKBENCH_REVIEW_ONLY", "WORKBENCH_EXECUTION_REPORT_ONLY"]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../mcp.mjs", import.meta.url))], {
      encoding: "utf8", timeout: 10_000,
      env: { ...mcpEnv, ...(role === "interactive" ? {} : { [role]: "1" }) },
      input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n",
    });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout.trim()).result;
    assert.equal(response.protocolVersion, "2024-11-05");
    if (role === "interactive") {
      assert.match(response.instructions, /WORKBENCH_ORCHESTRATION_V1/);
      assert.match(response.instructions, /in plan mode preview only/);
      assert.match(response.instructions, /approval and leaving plan mode/);
      assert.match(response.instructions, /reviewPacket.references/);
    } else assert.equal(response.instructions, undefined);
  }
});
