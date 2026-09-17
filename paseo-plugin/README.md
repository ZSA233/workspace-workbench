# Workspace Workbench Paseo 插件

原始需求、会话归档、图片和版本化交接见 [交接资料包](HANDOFF-MATERIALS.md)。

会话消息、进度查询、交接停止指引和主控审核的使用方式见 [会话与审核流程](SESSION-WORKFLOW.md)。

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
如果同一源码根目录已有登记的项目配置，向导会打开该项目，不再生成第二份配置或覆盖其仓库清单。

## 观察时序

项目配置中的 `limits.gitTimeoutSeconds` 是单条 Git 命令预算；观察总预算会自动使用它加
5 秒余量。也可以设置 `limits.observationTimeoutSeconds`，但不能低于这个派生下限，否则
配置会明确报告 `config_invalid`。摘要、历史图和 diff 使用事件版本缓存，不再因
`cacheTtlSeconds` 到期而完整扫描。活动页面每秒批量查询内存版本号，文件变化合并
300ms（最长 1 秒）后刷新；正常监听下每 5 分钟核对，监听降级时每 30 秒核对。
页面需求租约为 30 秒，租约到期后停止后台 Git 并释放监听；返回页面会核验旧快照。
摘要不计算 numstat，增删行数由 Changes 按需加载。观察总预算、Unix socket bridge 和面板刷新等待
会从同一份策略依次派生传输余量，因此调整 Git 超时后不会留下不一致的下游超时。

## 添加仓库

这里分为两个动作：

1. **自动发现**：初始化向导扫描 Git 根目录和嵌套仓库，供用户确认项目配置范围。
2. **加入已有 Workspace**：在 Workspace 面板点击“添加仓库”后，插件自动列出项目配置
   中尚未加入当前 Workspace 的仓库。用户确认仓库和 base ref，系统自动创建隔离分支、
   更新 manifest、准备运行时并记录逐库结果。

主工作区的“选择仓库”只调整观察和手动审核范围，不修改上述 Workspace 创建目录。
发现过程不按 `secrets`、`node_modules`、隐藏目录等名称自动排除仓库；只有项目明确配置的
`discovery.exclude` 会按名称排除。Git 元数据、实际状态和 worktree 生成目录按路径避开。
扫描达到时间或目录预算时，界面显示“扫描未完成”和已找到的候选；调整项目的扫描根目录、
深度或显式排除项后可重新扫描。

加入已有 Workspace 不是手动维护底层文件；明确确认只用于保护执行和审核范围。活动执行或
审核期间不会自动扩大范围。失败后可以用相同选择重试，已完成的 worktree 不会重复创建。
base ref 默认使用源码当前 `HEAD`，需要时可以展开设置。

## Gitlink 工作区

项目中的外层 Git 仓库如果用 gitlink 固定子仓提交，可在“选择 Gitlink 工作区”中勾选。
它会作为一个只读的聚合 Workspace 出现：外层仓库和每个子仓各有独立的 Git 状态、提交图
和 diff；“子仓指针”同时展示外层提交、暂存区及子仓当前 HEAD。子仓未提交的文件修改
只在子仓中显示，不会重复计为外层代码变更。子仓缺失或未初始化时保留对应行并显示问题。

新建时可选择已勾选的外层仓库。插件从外层基准提交读取 gitlink SHA，在嵌套目录中为
外层和全部子仓创建同名分支；子仓基准默认是外层固定的 SHA，可显式覆盖。创建只使用本地
已有 Git 对象，不自动 fetch、stage 或 commit。子仓提交后，外层指针差异会显示出来，
由开发者决定何时暂存和提交外层仓库。Gitlink 模式的记录留在插件状态目录，不往外层
工作树添加 manifest。干净工作区按子仓到外层顺序清理；任何用户修改或新增提交都阻止
清理并保留现场。普通平铺 Workspace 的流程保持原样。

## 接管没有记录的工作区

Workbench 会在配置的 `treesRoot` 下列出有 Git worktree、却没有有效 Workspace 记录的
直接子目录，并在选择器中标为“待认领”。打开候选后才核验各仓库的 Git 身份、当前 HEAD、
分支和修改；额外文件与旧元数据会提示为清理前需要处理的问题。确认接管前可以为处于
detached HEAD 的子仓逐个选择是否从当前提交创建分支。选择保持 detached 也可接管，
但后续提交可能没有分支引用。
未写入项目仓库注册表的源仓库也会通过 Git 的 worktree 登记关系识别；接管不会改写
项目注册表。若个别子仓仍无法确认源位置，可以接管已确认的仓库，未确认目录会原样保留并
在预览中提示，清理整个 Workspace 前仍须处理它。

认领记录使用兼容的 schema-v1 格式，标记 `origin: adopted` 并单独保存认领时的 HEAD。
原始创建基线、时间和请求不会被猜测。旧记录若无效，原文件会先备份到项目状态目录。
认领后可使用普通 Workspace 的观察、Agent 和审核入口。清理会重新检查身份、修改与
认领时 HEAD；detached 提交在移除 worktree 前保存到明确的 Git 引用，预览会列出引用。
任何新增提交、修改或未知容器文件仍会阻止清理。

## 运行时和交接

项目仓库可以声明 Go、Python 或 Node 运行时。这里的 Python 是业务项目的可选运行时，
Workbench 后端自身不再启动或下载 Python。

运行时安装数据由项目共享，保存在 `stateRoot/toolchains/mise`；`mise`、Go、pip 和 npm
缓存位于项目 `cache.root/workspaces/<Workspace ID>` 下，主工作区使用 `main`。
准备工具链、本地执行和 Agent 交接都会使用这些路径，不会把缓存写到源码仓库。
已有缓存不自动迁移或删除；目录不可写时会报告错误。

Agent 交接、Review、权限和计划/执行模式见[根目录 README](../README.md)及
[Agent Workspace 流程](../docs/agent-workspace-flow.md)。Reviewer 使用独立只读会话；
审核历史和 handoff 会保留在项目状态目录中。

固定版本或离线安装可使用 GitHub Release 压缩包。压缩包包含 Node 后端源码，不包含项目
配置、Workspace 记录、缓存、socket、Agent 绑定或 secret。

## 连接超时排查

MCP 每次工具调用建立独立连接，总预算 55 秒，包含排队；连接最多 8 秒，预留
1 秒清理，RPC 使用剩余预算。最多 4 个活动调用、16 个排队调用；ping 和取消通知
独立处理。取消和 stdin 关闭会回收本次连接，清理异常记入诊断而不覆盖执行结果。
连接阶段失败不会发送业务请求；RPC 超时则不代表
服务端操作已撤销，必须沿用原 requestId 查询状态，不能创建新身份盲目重试。
连接清理失败不能覆盖已经收到的成功结果或原始错误。

`running` 只表示插件进程存在。排查时分别检查 Paseo RPC、后端
`observer.health` 的 `activeRequests`/`closing` 和 Paseo daemon 日志。
`session_caller_not_coordinator` 是会话授权错误；材料类型或路径错误也是校验失败，
都不应通过反复重载修复。多个 MCP 进程可能分别属于不同活动会话，不能批量终止。

普通平铺多仓 Workspace 的容器本身不是 Git 仓库；Gitlink 模式则保留外层 Git worktree，
并在其中放置各子仓 worktree。若平铺容器位于另一个 Git 仓库之下，Paseo 的
Git watcher/reconciliation 可能向上发现外层仓库并重复扫描；用
`git -C <workspace-container> rev-parse --show-toplevel` 确认扫描对象，再检查
宿主日志中的 `git status --porcelain` 超时。这与 Workbench 后端健康检查是不同链路。
不要为消除扫描而删除外层 `.git` 或给容器初始化新的 Git 仓库。

本地目录插件的 MCP 源码修改由新启动的 MCP 进程加载。插件 reload 只重载 Paseo
插件及其后端，不会替换已有 Agent 持有的 MCP 进程；已有会话须由宿主重新连接 MCP
或在新会话验证，不能声称 reload 已让全部旧会话生效。

详细设计、兼容边界和验证命令见 [观察与传输链路](../docs/observation-and-transport.md)。

无头浏览器验收可运行 `npm --prefix paseo-plugin run test:plugin-ui`；首次使用先执行
`npm --prefix paseo-plugin exec -- playwright install chromium`。测试会启动隔离的
真实 Paseo 页面，验证自动刷新与崩溃恢复，并在 `.local/verification/ui/` 保存截图。
