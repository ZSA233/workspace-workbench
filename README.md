# Workspace Workbench

Workspace Workbench 用于观察和管理包含多个 Git 子仓库的工作区。它提供
TypeScript/Node.js 服务和 Paseo 插件，用于查看仓库状态、提交历史、文件变化、Review set
以及可选的 Agent 交接。

## 运行环境

正式运行需要 Node.js 22.14+ 和 Git，不需要安装 Python 后端。安装并启用 Paseo 插件后，
首次打开 Workbench 会展示项目初始化向导；插件统一启动所有已登记项目的 Node 后端，
重载/卸载时负责退出与 socket 回收，异常退出后在下一次请求恢复。

开发者也可以使用 Node CLI：

```sh
node --experimental-strip-types paseo-plugin/server/backend/main.ts init --root /path/to/project --output /path/to/project/workbench.json
node --experimental-strip-types paseo-plugin/server/backend/main.ts discover --config /path/to/project/workbench.json
node --experimental-strip-types paseo-plugin/server/backend/main.ts accept --config /path/to/project/workbench.json --repository services/api
node --experimental-strip-types paseo-plugin/server/backend/main.ts serve --config /path/to/project/workbench.json
```

`serve --stdio` 使用兼容 JSON 行协议；`exec --config ... --workspace ... --repo ... -- COMMAND`
仅在本地显式调用，验证已准备的运行时后执行。RPC 不开放任意命令执行。
Python 源码暂留作旧版本兼容与协议对照测试，不参与插件后端选择、启动或正常运行。

向导默认将当前 Git 根目录作为一个仓库（配置路径为 `.`），配置保存在项目内的
`.workspace-workbench/project.json`。隔离 Git worktree 默认放在
`.workspace-workbench/worktrees/`，运行状态和记录放在 `.workspace-workbench/state/`。
配置默认通过 Git 的本地 `info/exclude` 忽略；运行状态、Socket、缓存和隔离 worktree
不会进入提交。三个点菜单中的“项目存储位置”可以随时查看当前项目的实际路径。
需要团队共享时，可以在向导的高级设置中打开“共享项目配置”，然后由用户自行提交配置文件。

已有配置中的 `workspaceRoot`、`treesRoot`、`recordsRoot` 和 `stateRoot` 会继续按原路径使用，
不会自动移动已有的 worktree。

如果配置了 `toolchain`，`mode` 默认为 `auto`：Workbench 会先验证系统中已有的 Go、Python
或 Node 版本，只有缺少匹配版本时才使用可选的 mise。`mise` 不需要写入 shell 启动脚本；也可以
通过 `managerPath` 或 `runtimePaths` 为非标准安装位置提供明确路径。项目级共享缓存默认放在
`stateRoot/cache`，用于 Go 编译/模块、NPM 和 pip 下载缓存；`node_modules`、`.venv` 和构建产物
仍然属于各自 Workspace，不会跨 Workspace 共用。

插件中可从顶部“三点菜单 → 项目运行时设置”修改运行时策略、mise/运行时路径和项目缓存位置；
同一页面也可以编辑按仓库划分的运行时要求 JSON。保存后服务会热加载配置，已有 Workspace 需要
再次点击“准备运行时”。

## 安装 Paseo 插件

直接从 GitHub 安装：

```sh
paseo plugin install ZSA233/workspace-workbench:paseo-plugin \
  --ref stable \
  --id workspace-workbench-paseo \
  --json
```

普通用户打开插件后即可开始使用。开发版本可以使用
`--ref main`。更新 Git 管理的插件：

```sh
paseo plugin update workspace-workbench-paseo --json
```

首次使用请在 Paseo 的“设置 → 插件”中打开“启用插件”全局开关；如果插件显示为已启用但尚未运行，再执行一次 `paseo plugin reload workspace-workbench-paseo --json`。

`stable` 跟随已经验证过的发布版本。固定 tag（例如 `v0.1.0`）不会自动升级，
需要手动切换到新的 tag。离线或需要审计的安装方式见
[`docs/releasing.md`](docs/releasing.md)。

## 可选的 Agent 交接

从用户视角查看“直接在当前工作区执行”和“创建独立 Workspace 执行”的完整流程，见
[`docs/agent-workspace-flow.md`](docs/agent-workspace-flow.md)。

如果需要 Paseo Agent 编排，在项目 JSON 中加入：

```json
{
  "management": { "enabled": true },
  "agent": {
    "provider": "paseo",
    "bridge": {
      "script": "../workspace-workbench/paseo-plugin/mcp.mjs",
      "endpoint": "auto"
    },
    "session": {
      "defaultRelationship": "independent",
      "providerRelationships": {
        "codex": "independent"
      }
    }
  }
}
```

`script` 路径相对于项目 JSON。插件加载后，新建 coordinator Agent 时才会注入
bridge。已经存在的会话不会被静默修改。Agent 可使用以下工具：

```text
workbench_workspace_preview
workbench_workspace_execute
workbench_workspace_status
```

执行会话默认是独立的 Paseo 会话。可以在 Workbench 顶部三个点菜单的“Agent session settings”中
按项目和 provider 选择“独立会话”或“子 Agent”，也可以在单次交接时覆盖。独立会话不会跟随主控会话
结束，也不会把状态用 `steer` 回灌主控对话。

完成交接后，执行 Agent 可以提交明确的 `ready_for_review` 报告；普通对话结束不会自动触发审核。
在非主 Workspace 的面板中打开 `Agent Review` 页签即可手动开始审核。审核设置从顶部三个点菜单进入，
可以分别设置会话关系、审核模式、自动修复、审核轮次、Reviewer 要求和 Codex 模型；项目设置优先于全局默认。
审核期间会在当前 Workspace 的时间线中显示执行、审核、修复和结果。Reviewer 使用独立的只读沙箱，
只能读取固定快照并提交结构化结果。`approved` 只代表对应代码版本通过审核，不会自动合并或发布。

主控 Agent 还可以使用以下 Review 工具：

```text
workbench_review_preview
workbench_review_execute
workbench_review_status
workbench_review_stop
workbench_review_resume
```

`preview` 只读。`execute` 需要用户明确要求隔离 Workspace、批准计划，并继续遵守
宿主的权限检查。从面板手动创建 Workspace 不会自动创建 Agent。

## 配置与开发

配置示例见 [`examples/project.json`](examples/project.json)，字段定义见
[`schemas/project.schema.json`](schemas/project.schema.json)。SQLite 状态、Socket、
Agent 绑定和其他运行数据应放在版本控制之外。

```sh
make version-check
make check
make package
```

Agent 流程和恢复规则见 [`docs/agent-orchestration.md`](docs/agent-orchestration.md)，
版本管理与 GitHub 发布见 [`docs/releasing.md`](docs/releasing.md)。

## 给已有 Workspace 添加仓库

在活动的托管 Workspace 点击“添加仓库”，选择已登记但遗漏的仓库及 base ref。
Workspace ID、原仓库和历史保持不变。活动执行/审核期间禁止扩展范围；失败保留逐库日志，
使用相同选择重试可恢复，不重复创建已完成的 worktree。新增仓库使用现有运行时准备流程，
并出现在后续 handoff 范围中。

计划模式、子会话启动意图与权限预设独立显示和校验。`full-access` 不代表执行模式，
`running` 不代表模式未知；Workbench 在创建及首次投递前读取宿主模式，计划/未知状态下
阻止执行，不自动切换模式，也不以最初 startMode 永久约束复用会话。

架构、兼容限制和实际插件验证见 [Node 后端说明](paseo-plugin/backend/README.md)。
