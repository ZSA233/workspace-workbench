# Workspace Workbench Paseo 插件

插件把 Workspace Workbench 放在 Paseo Explorer 中。普通用户不需要单独启动服务；插件
使用 Node.js 22.14+ 统一管理各项目的 TypeScript 后端，并在重载或卸载时回收属于自己的
后端进程和 socket。

## 安装

```sh
paseo plugin install ZSA233/workspace-workbench:paseo-plugin \
  --ref stable \
  --id workspace-workbench-paseo \
  --json
paseo plugin update workspace-workbench-paseo --json
```

开发版本使用 `--ref main`。本地开发可以安装插件目录：

```sh
paseo plugin install /path/to/workspace-workbench/paseo-plugin --json
paseo plugin reload workspace-workbench-paseo --json
```

首次使用时在 Paseo 的“设置 → 插件”中启用插件。打开没有项目配置的 Git 目录后，插件
会自动扫描并列出可用仓库；确认后生成 `.workspace-workbench/project.json`，并自动登记
项目、准备配置和启动后端。用户不需要编辑 JSON、维护项目注册表或手动创建 worktree。

## 添加仓库

这里分为两个动作：

1. **自动发现**：初始化向导扫描 Git 根目录和嵌套仓库，供用户确认项目配置范围。
2. **加入已有 Workspace**：在 Workspace 面板点击“添加仓库”后，插件自动列出项目配置
   中尚未加入当前 Workspace 的仓库。用户确认仓库和 base ref，系统自动创建隔离分支、
   更新 manifest、准备运行时并记录逐库结果。

加入已有 Workspace 不是手动维护底层文件；明确确认只用于保护执行和审核范围。活动执行或
审核期间不会自动扩大范围。失败后可以用相同选择重试，已完成的 worktree 不会重复创建。
base ref 默认使用源码当前 `HEAD`，需要时可以展开设置。

## 运行时和交接

项目仓库可以声明 Go、Python 或 Node 运行时。这里的 Python 是业务项目的可选运行时，
Workbench 后端自身不再启动或下载 Python。

Agent 交接、Review、权限和计划/执行模式见[根目录 README](../README.md)及
[Agent Workspace 流程](../docs/agent-workspace-flow.md)。Reviewer 使用独立只读会话；
审核历史和 handoff 会保留在项目状态目录中。

固定版本或离线安装可使用 GitHub Release 压缩包。压缩包包含 Node 后端源码，不包含项目
配置、Workspace 记录、缓存、socket、Agent 绑定或 secret。
