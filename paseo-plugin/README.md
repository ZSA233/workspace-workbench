# Workspace Workbench Paseo 插件

插件将 Workbench 放在 Paseo 的 Explorer 中，Agent 对话仍保留在主区域。普通用户无需
单独启动 Python 服务，插件会自动使用内置或本机可用的 Workbench 后端。

## Git 安装

直接从 GitHub 安装：

```sh
paseo plugin install ZSA233/workspace-workbench:paseo-plugin \
  --ref stable \
  --id workspace-workbench-paseo \
  --json
paseo plugin update workspace-workbench-paseo --json
```

开发分支使用 `--ref main`。Paseo 会先拉取代码、安装锁定的依赖、执行类型检查，
验证通过后才激活新版本。

首次使用请在 Paseo 的“设置 → 插件”中打开“启用插件”全局开关；如果插件显示为已启用但尚未运行，再执行一次 `paseo plugin reload workspace-workbench-paseo --json`。

## 本地安装

```sh
paseo plugin install /path/to/workspace-workbench/paseo-plugin --json
paseo plugin reload workspace-workbench-paseo --json
```

打开一个没有配置的 Git 项目时，插件会自动扫描当前目录并打开初始化向导。确认仓库
范围后，它会在项目内生成 `.workspace-workbench/project.json`，自动登记并启动后端；
用户不需要编辑 JSON 或手动维护 `projects.json`。

如果需要手动启动后端（例如服务器或调试环境），可以使用项目配置启动服务：

```sh
workspace-workbench serve --config /path/to/project/workbench.json
```

项目根目录本身是 Git 仓库时，向导默认使用 `path: "."`；子仓库只在用户展开并选择
后才会加入。新项目的配置、隔离 worktree 和状态分别位于
`.workspace-workbench/project.json`、`.workspace-workbench/worktrees/` 和
`.workspace-workbench/state/`。默认配置使用 Git 的本地 `info/exclude` 忽略，运行状态和
隔离 worktree 不会写入提交；三个点菜单中的“项目存储位置”可查看实际路径。

已有配置会继续使用其中声明的存储路径，不会自动迁移。

如需 Agent 交接，请按[根目录 README](../README.md) 配置 `agent.provider` 和
`agent.bridge`，然后新建 coordinator Agent。已经存在的 Agent 会话不会被静默修改。

完成交接后，在对应的非主 Workspace 中打开 `Agent Review` 页签。顶部三个点菜单可配置项目或全局
审核模式、自动修复、审核要求、轮次和 Codex 模型。执行 Agent 必须提交 `ready_for_review` 报告，
Reviewer 才会读取固定代码快照并给出结构化结论；`changes_requested` 可以把问题交回同一个执行
Agent。时间线和历史轮次会保存在项目的 `stateRoot/reviews` 下，审核通过不代表自动合并。

发布压缩包适合固定版本或离线安装，包含匹配平台的后端 worker。压缩包不包含项目
配置、缓存、Socket、Agent 绑定或 secret。
