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

创建项目配置并登记仓库：

```sh
workspace-workbench init --root /path/to/project --output /path/to/project/workbench.json
workspace-workbench discover --config /path/to/project/workbench.json
workspace-workbench accept --config /path/to/project/workbench.json --repository services/api
workspace-workbench serve --config /path/to/project/workbench.json
```

`discover` 只显示候选仓库。使用 `accept` 逐个确认，或直接编辑 JSON 配置。
配置中的路径可以相对于配置文件填写。

## 安装 Paseo 插件

将 `OWNER` 替换为此 GitHub 仓库的所有者：

```sh
paseo plugin install OWNER/workspace-workbench:paseo-plugin \
  --ref stable \
  --id workspace-workbench-paseo \
  --json
```

启动对应的 Workbench 服务后，在 Paseo 中打开插件。开发版本可以使用
`--ref main`。更新 Git 管理的插件：

```sh
paseo plugin update workspace-workbench-paseo --json
```

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
