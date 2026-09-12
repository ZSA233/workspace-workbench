# Agent 编排

Agent 编排是可选能力。它由项目配置开启，并继续使用 Paseo 的 Agent 权限和 sandbox 策略。

## Bridge 工作方式

Paseo 创建新的主控 Agent 时，插件 hook 会根据 Agent 的工作目录匹配已登记的 Workbench
项目。如果项目配置了 Paseo bridge，hook 会注入本地 `mcp.mjs` 进程、项目身份和简短的
系统指引。这个进程由 Paseo 为 Agent 启动，不需要用户另外执行创建子 Agent 的脚本。

Bridge 只暴露以下公开工具：

```text
workbench_workspace_preview
workbench_workspace_execute
workbench_workspace_status
```

这些工具和面板使用同一个 Workbench 编排器。为了兼容不执行工具搜索的 provider，新建的
主控 Agent 会常驻加载这个 bridge；工具 schema 和说明保持精简，也不会暴露项目专属仓库名。

## 标准流程

1. 用户明确要求创建隔离 Workspace。
2. 规划模式下，主控 Agent 只能调用 `workbench_workspace_preview`。
3. 用户批准并退出规划模式后，调用 `workbench_workspace_execute`，请求身份保持不变。
4. Workbench 创建或复用选中的 Workspace，准备声明的运行时，校验路径和 Git 身份，然后在
   该 Workspace 中创建或复用子 Agent。
5. 主控 Agent 继续负责协调，子 Agent 负责修改文件。
6. 结果不确定时，主控 Agent 使用 `workbench_workspace_status` 查询状态。

重试必须保持相同的 `requestId` 和完整请求内容。重复请求会从已记录的阶段继续，不会再次
创建 Workspace 或子 Agent。

## 已存在的会话

当前 Paseo 插件 API 可以在创建 Agent 和打开会话时注入配置，但不能安全地改写已经运行的
会话的 MCP 配置。因此已有会话保持不变。面板会明确提示当前 Agent 会话没有 Workbench
上下文，不会把它误显示成可以直接交接。

需要使用 bridge 时，先启动服务、重载插件，然后在已登记的项目中创建新的主控 Agent。不要
仅为了增加这个可选集成而重启或修改正在运行的 Agent。

## 安全边界

- main/live Workspace 只支持观察，不用于 Agent 交接写入。
- `preview` 不创建 worktree、不准备运行时，也不创建 Agent。
- `execute` 交接前会校验项目、主控 Agent、工作路径和执行模式。
- 子 Agent 不会获得主控工具，也不能递归交接。
- 宿主的权限提示和 sandbox 设置始终优先。
- 创建或投递结果不确定时会停止并从保存状态恢复，不会自动创建替代 Agent。
