# Workspace Workbench

Workspace Workbench 用于观察和管理包含多个 Git 子仓库的工作区。它提供
Python 服务和 Paseo 插件，用于查看仓库状态、提交历史、文件变化、Review set
以及可选的 Agent 交接。

## 安装服务

从源码目录安装：

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install -e .
```

普通用户无需手动创建配置。安装并启用 Paseo 插件后，第一次在 Git 项目中打开
Workbench，插件会扫描当前目录并展示初始化向导；确认后会自动生成项目配置、登记项目
并启动观察服务。

开发者或无 Paseo 环境时，仍可使用 CLI 创建配置并登记仓库：

```sh
workspace-workbench init --root /path/to/project --output /path/to/project/workbench.json
workspace-workbench discover --config /path/to/project/workbench.json
workspace-workbench accept --config /path/to/project/workbench.json --repository services/api
workspace-workbench serve --config /path/to/project/workbench.json
```

`discover` 只显示候选仓库。使用 `accept` 逐个确认，或直接编辑 JSON 配置。
配置中的路径可以相对于配置文件填写。

向导默认将当前 Git 根目录作为一个仓库（配置路径为 `.`），配置保存在项目内的
`.workspace-workbench/project.json`。隔离 Git worktree 默认放在
`.workspace-workbench/worktrees/`，运行状态和记录放在 `.workspace-workbench/state/`。
配置默认通过 Git 的本地 `info/exclude` 忽略；运行状态、Socket、缓存和隔离 worktree
不会进入提交。三个点菜单中的“项目存储位置”可以随时查看当前项目的实际路径。
需要团队共享时，可以在向导的高级设置中打开“共享项目配置”，然后由用户自行提交配置文件。

已有配置中的 `workspaceRoot`、`treesRoot`、`recordsRoot` 和 `stateRoot` 会继续按原路径使用，
不会自动移动已有的 worktree。

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

如果需要 Paseo Agent 编排，在项目 JSON 中加入：

```json
{
  "management": { "enabled": true },
  "agent": {
    "provider": "paseo",
    "bridge": {
      "script": "../workspace-workbench/paseo-plugin/mcp.mjs",
      "endpoint": "auto"
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

完成交接后，执行 Agent 可以提交明确的 `ready_for_review` 报告；普通对话结束不会自动触发审核。
在非主 Workspace 的面板中打开 `Agent Review` 页签即可手动开始审核。审核设置从顶部三个点菜单进入，
可以分别设置审核模式、自动修复、审核轮次、Reviewer 要求和 Codex 模型；项目设置优先于全局默认。
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
