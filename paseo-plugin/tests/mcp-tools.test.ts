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
    "workbench_workspace_preview",
    "workbench_workspace_execute",
    "workbench_workspace_status",
  ]);
  for (const tool of response.result.tools) {
    assert.ok(tool.description.length < 70);
    assert.deepEqual(tool.inputSchema.required, ["requestId", "handoff"]);
  }
});
