# Workspace Workbench

Workspace Workbench 用于查看和管理包含多个 Git 仓库的项目。它提供 Workspace
列表、提交历史、文件变化、Review set，以及可选的 Paseo Agent 交接。

## 快速开始

正式运行需要 **Node.js 22.14+**、Git 和 Paseo。Workbench 自己的服务使用 Node.js，
不会安装或启动 Python 服务；项目本身仍可以声明 Go、Python 或 Node 运行时。

### 安装插件

```sh
paseo plugin install ZSA233/workspace-workbench:paseo-plugin \
  --ref stable \
  --id workspace-workbench-paseo \
  --json
```

在 Paseo 的“设置 → 插件”中启用插件。更新已安装插件：

```sh
paseo plugin update workspace-workbench-paseo --json
```

开发版本可以把 `--ref stable` 换成 `--ref main`。插件显示已启用但没有运行时，执行：

```sh
paseo plugin reload workspace-workbench-paseo --json
```

### 初始化项目

在一个 Git 项目中打开 Workbench。首次打开时，插件会自动扫描当前 Git 根目录和常见的
嵌套仓库，并在初始化向导中列出候选仓库。确认范围后，Workbench 会自动保存项目配置并
启动后端；不需要编辑 JSON 或维护 `projects.json`。

默认配置和运行数据位于项目的 `.workspace-workbench/` 目录，其中包括项目配置、隔离
worktree、记录和缓存。运行数据默认由 Git 本地忽略。已有项目会继续使用原来的存储路径。

## Workspace 和仓库

- **新建 Workspace**：从自动发现的仓库中选择范围，系统创建隔离分支和 worktree。
  base ref 默认使用源码当前 `HEAD`，需要时可以在对话框中指定。
- **给已有 Workspace 添加仓库**：系统自动列出项目配置中尚未加入该 Workspace 的仓库，
  用户只需确认要加入哪些仓库和 base ref。创建 worktree、更新 manifest、运行时准备、
  失败恢复和重复请求都由 Workbench 自动完成，不需要用户手动执行 Git 命令。
- 添加仓库会改变 Workspace 范围，因此执行或审核进行中会暂时禁止添加；任务结束后可继续。
  失败时保留逐库记录，使用相同选择重试不会重复创建已完成的 worktree。
- 删除会检查脏工作树、用户提交和身份变化；不满足安全条件时保留文件、分支和历史。

“自动发现”负责找到可用仓库，“添加到已有 Workspace”需要一次明确确认，这是为了避免
执行或审核范围被静默扩大。

## 运行时和 Agent

如果项目配置了 `toolchain`，在 Workbench 的“项目运行时设置”中准备所需版本和缓存。
这些运行时属于业务仓库；Python 只在项目明确要求 Python 时使用。

需要 Agent 交接时，参阅[Agent Workspace 流程](docs/agent-workspace-flow.md)。执行会话、
计划/执行状态、权限预设和 Reviewer 生命周期彼此独立；Workbench 不会自动切换主控模式，
也不会在复用会话时重复投递同一 handoff。

## 进一步阅读

- [Agent 编排和恢复](docs/agent-orchestration.md)
- [验证记录](docs/verification/backend-parity-review-recovery-20260914.md)
- [Node 后端职责和兼容性](paseo-plugin/backend/README.md)
- [发布和固定版本安装](docs/releasing.md)

开发者可以运行 `make check` 检查插件类型和测试，运行 `make package` 构建发布形态的
插件压缩包。
