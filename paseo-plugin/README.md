# Workspace Workbench Paseo 插件

原始需求、会话归档、图片和版本化交接见 [交接资料包](HANDOFF-MATERIALS.md)。

会话消息、进度查询、交接停止指引和主控审核的使用方式见 [会话与审核流程](SESSION-WORKFLOW.md)。

插件把 Workspace Workbench 放在 Paseo Explorer 中。普通用户不需要单独启动服务；插件
使用 Node.js 22.14+ 统一管理各项目的 TypeScript 后端，并在重载或卸载时回收属于自己的
后端进程和 socket。

Paseo Web 0.13 的 Explorer 使用官方插件面板入口。在右侧“＋”中选择 Workspace Workbench，即可添加工作台标签；普通浏览器和 Pocket 使用相同注册。面板复用插件已有 RPC 和缓存，不依赖 Pocket 侧栏 SDK。

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

首次使用时在 Paseo 的“设置 → 插件”中启用插件，从当前工作区的“＋”菜单打开 Workbench。
打开没有项目配置的目录后，插件会自动扫描并列出可用仓库；确认后生成
`.workspace-workbench/project.json`，并自动登记项目、准备配置和启动后端。目录本身不是
Git 仓库时也支持发现下方多个仓库并一起选择，默认向下扫描三层。用户不需要编辑 JSON、
维护项目注册表或手动创建 worktree。
如果同一源码根目录已有登记的项目配置，向导会打开该项目，不再生成第二份配置或覆盖其仓库清单。
全局入口没有当前工作区上下文，需要手动选择已登记项目；无法读取工作区目录时，插件不会
自动打开其他项目。

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

1. **自动发现**：初始化向导扫描 Git 根目录和嵌套仓库，或非 Git 目录下的仓库，供用户确认项目配置范围。
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

## Codex 会话自动恢复

插件启用后，同一个 Paseo 服务中的所有普通 Codex 会话默认开启自动恢复，包括未登记
Workbench 项目的会话、Worker 和 Reviewer。已有会话会列入覆盖范围；不会自动唤醒此前
失败、关闭或归档的历史会话，而是从新发生的失败开始处理。

桌面网页端从左侧 **会话自动恢复** 入口查看按 Paseo Workspace 分组的会话列表，也可点击
会话输入区上方的恢复状态按钮；iOS 使用会话操作中的 **当前会话自动恢复** 入口。
这里能看到是否开启、尝试次数、倒计时及停止原因，并可以关闭单个
会话、停止本次恢复或点击“立即继续／立即重试”执行已经排队的尝试。页面也展示实际使用的
恢复方式。Workbench 工具接入和 Worker／Reviewer
角色另外展示；它们不决定自动恢复的覆盖范围。当前 Paseo 插件接口不支持左侧每条会话的
自定义徽标，因此提供独立入口和会话操作。iOS 仅在恢复页面挂载且应用处于前台时
每 5 秒读取状态，关闭页面后释放会话列表。

**Android 暂停提供自动恢复界面**：不加载恢复模块，不注册恢复入口、按钮、监听或定时器，
也不读取恢复状态。恢复判断、计时与发送继续仍由服务端负责，覆盖 Android 打开的会话；
如需修改恢复设置，可从桌面或 iOS 操作。Android 的 Workbench 入口和文件查看保留，
普通聊天时不枚举或监听 Workspace，也不注册逐 Workspace 的标题按钮；目录信息仅在
打开 Workbench 时读取，关闭后释放。详见[排查记录](../docs/android-client-pressure.md)。

默认在明确失败后等待 **10 秒，附加 0～2 秒随机延迟**，本轮恢复最长 **1 小时**。
设置页支持修改间隔、最长时间，或选择“持续重试直到手动停止”；单会话开关优先于全局
默认。新恢复回合不会重置本轮时间预算。关闭自动恢复或停止本次恢复不会中断已经运行的
Agent；用户新回合、模式变化、权限请求及归档会撤销旧的恢复计划。

只恢复模型过载、明确的临时限流、连接故障及已知由连接故障导致的重试耗尽。额度、认证、
上下文限制及原因不明的重试耗尽需要用户处理。**默认恢复方式为发送继续消息，无需修改
Paseo 宿主或安装补丁**：通过公开消息接口在原会话发送一句 `继续`，不附加系统说明，
不重投整份 handoff。设置可修改这句消息，或选择“优先原生，缺失时发送继续”。两种方式
均保留原上下文、模型与权限，发送前重新验证会话及授权；消息方式使用固定消息 ID 和
历史核实投递。由于宿主没有原子的空闲时发送接口，消息方式仍存在发送前检查与发送之间
的竞态，`steer` 也可能回退为替换回合；不能保证工具操作恰好执行一次。

选择优先原生且接口可用时，宿主在原 Codex thread 调用 `turn/start` 并传入 `input: []`。
它会建立新的执行尝试，不增加用户消息、空白消息或续跑提示词。投递前后使用独立的宿主
凭据登记尝试 ID 和实际回合 ID。原生接口不可用时，在投递前选择消息方式；
已经发起的原生或消息投递遇到超时、断线或结果不确定时，只核实既有投递，不换方式重发。

原生恢复是可选增强。当前 Paseo 0.11.0 的公开插件接口无法传递空输入，使用原生方式需
安装版本受限的本地宿主兼容桥：
`node paseo-plugin/scripts/install-native-recovery-host.mjs` 仅检查，附加 `--apply` 才安装。
安装器只修改已识别的 `@getpaseo/server` 0.11.0 入口，并保留 `.workbench-native-recovery.original`
备份。宿主必须重新启动才能加载接口；插件 reload 不能更新宿主代码。先结束需要保留的活动
回合，再执行 `paseo daemon restart --json` 和 `paseo plugin reload workspace-workbench-paseo --json`。
宿主升级后须重新检查兼容性。接口缺失不影响继续消息恢复，也不影响会话列表或状态按钮。

Worker 和 Reviewer 等待恢复时保持原任务和审核轮次，暂停阶段超时计时；恢复后重新验证
冻结材料、任务范围和 Reviewer 快照，继续使用剩余预算。失败回合的审核候选结果不能作为
批准依据。首次 handoff 投递不确定时不会自动恢复或重投。

恢复设置使用独立的 host 级 `workspace-workbench-recovery` 设置；状态在当前
`PASEO_HOME/workspace-workbench/recovery/` 下按服务身份隔离。全局 RPC
`workspace.workbench.recovery` 提供 `list`、`get`、`setEnabled`、`cancel` 和 `retryNow`，
不要求项目路径或 Workbench Agent token。

实际宿主验收：`WORKBENCH_LIVE_RECOVERY=1 node paseo-plugin/scripts/verify-live.mjs`。
它使用隔离 Paseo home、注册表和本地 Codex app-server 协议替身，验证默认继续消息、
可选原生恢复和插件重载；不会调用真实模型或重载日常插件。
另运行 `WORKBENCH_LIVE_RECOVERY=1 WORKBENCH_LIVE_RECOVERY_NO_NATIVE=1 node paseo-plugin/scripts/verify-live.mjs`
可在隔离进程中加载原始 Paseo 会话处理代码，验证未安装原生接口时的自动兜底；不会修改
本机已安装的宿主文件。运行
`WORKBENCH_UI_RECOVERY_ONLY=1 npm --prefix paseo-plugin run test:plugin-ui` 可自动启动
同样的隔离宿主，检查实际设置页、等待状态、控制按钮和会话输入区入口，完成后关闭隔离宿主。
`node paseo-plugin/scripts/verify-native-codex-retry.mjs` 另用实际 Codex app-server、隔离
`CODEX_HOME` 和本地 Responses 替身，验证失败后的空输入保持模型上下文及用户消息数量；
这与协议替身验证不同，仍不调用真实模型。

## 运行时和交接

Workspace 创建与 Agent 交接是两个独立动作。`workbench_workspace_create` 只创建或恢复
Git worktree，不要求 Agent token、handoff 或 Reviewer；返回 `operationId` 后可用
`workbench_workspace_operation_status` 查询。普通平铺 Workspace 遗漏仓库时，可用
`workbench_workspace_add_repositories` 在原 Workspace 中幂等补充，不会创建新 Workspace 或
Agent 会话；Gitlink Workspace 的成员仍由外层指针固定。`workbench_workspace_status` 用于
handoff 的 `requestId`，不能用 `workspaceId` 单独代替；需要执行 Agent 时，再显式使用交接入口，子会话
会固定在新 worktree 中，当前会话不会切换 cwd。审核默认关闭，只有用户主动启动时才运行。

交互式 Agent 在项目配置存在 `agent.bridge` 时默认使用插件级共享 HTTP MCP 网关；这不会为每个
会话创建独立的 `mcp.mjs` 进程。需要关闭自动注入时，在 `agent.bridge` 中显式设置
`autoInject: false`。Worker 和 Reviewer 也复用同一个网关，只通过会话角色限制工具范围。
已有会话或手工配置的 stdio MCP 仍可继续使用，但会在诊断中标记为 `legacy-stdio`。

网关按插件进程单例运行。每个 Paseo home 首次分配的回环端口及密钥保存在插件状态目录；
插件 reload 和网关崩溃恢复继续使用同一地址。新一代只等待已验证的旧网关释放端口，
未知进程占用时报告错误并重试原端口，不会静默改用新端口或终止未知进程。插件只关闭
自己拥有的网关；已有共享 HTTP Agent 的下一次调用可以连接到新一代网关。
`/health` 只检查 HTTP 存活，带网关密钥的 `/ready` 还会检查 Paseo 连接和插件 RPC；
只有后者通过才给新 Agent 注入 MCP 配置。`workbench_connection_status` 可在没有项目上下文时
查看这三个阶段。历史 stdio 会话仍由宿主自行管理。

出现连接、刷新或 Android 入口异常时，可以调用只读诊断接口
`workspace.workbench.diagnostics`（或轻量的 `workspace.workbench.mcp.status`），也可以在插件状态目录查看最近的脱敏 JSONL 事件。诊断会显示插件
generation、网关 PID/端口、活动请求、租约、超时和清理失败；不会保存 token、凭证、文件内容或
完整 handoff 正文。

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

MCP 每次工具调用建立独立连接，总预算 55 秒，包含排队；只有短只读查询使用 6 秒预算，
Workspace 创建和添加仓库使用完整预算。连接最多 8 秒，预留
1 秒清理，RPC 使用剩余预算。最多 4 个活动调用、16 个排队调用；ping 和取消通知
独立处理。取消和 stdin 关闭会回收本次连接，清理异常记入诊断而不覆盖执行结果。
连接阶段失败不会发送业务请求；RPC 超时则不代表
服务端操作已撤销，必须沿用原 requestId 查询状态，不能创建新身份盲目重试。
连接清理失败不能覆盖已经收到的成功结果或原始错误。
创建和提交工具若未传 `requestId`，会从项目与规范化输入生成稳定身份。调用结果不确定时，
先用返回的身份查询状态，再用同一身份重试；不要改用新身份或手工建立 worktree。

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
工作区目录识别和非 Git 多仓初始化的专项验收可运行
`node paseo-plugin/scripts/verify-workspace-routing-ui.mjs`；该脚本使用隔离的 Paseo home、
项目注册表和临时仓库，不会重载用户正在使用的插件。

## Session tools and project caches

Repository `mise.toml` (or `.mise.toml`) is the primary declaration for supported
Go, Node and Python numeric versions. Repositories without a manifest use legacy `toolchain.repositories` declarations. Other mise tools are reported as unmanaged; Workbench does
not execute project TOML environment directives. A conflicting declaration is
reported with its source instead of selecting two versions independently.

Ordinary Agent creation, interactive session opening, Workbench child sessions and
local CLI execution share this resolver. Ready tools and cache paths are startup
defaults. User environment overrides remain effective. Missing tools use the
existing durable preparation operation; they do not block ordinary Agent creation.
Preparation success and actual executable version are separate checks. A pending
or failed preparation does not prove that a bare command uses the required version.
Project build/test entry points must verify that version before execution.

These defaults do not grant exclusive Workspace access. An ordinary session can
operate in multiple Workspaces. Shell directory changes do not reconfigure an
already running process: use the project's standard mise or command entry point
when tool requirements differ. Workbench execution/review scopes still protect
the specific delegated operation. No global shell configuration is changed.

Opt in to cache sharing with `"cache": { "scope": "project" }`. The default remains
`workspace`. Project caches share dependency data and compatible compiler entries;
source files, build outputs, logs and running state remain in their original scopes.
Optional `toolchain.miseDataRoot` selects an existing shared mise installation directory outside source/worktrees; the historical private installation default remains compatible. Historical caches are neither moved nor removed. Docker builder caches are separate
from host compiler caches.

Package caches include uv even when the selected task only declares another
tool. New Codex sessions receive access to the verified cache directory through
the host's existing writable-root option. Source directories and mise's installed
tool directory are not added. Explicit read-only/full-access presets, planning
state, network policy and caller roots remain unchanged. Caller-provided descriptor
files or cache overrides do not authorize additional paths.

The internal `workspace.environment` response and `WORKBENCH_ENVIRONMENT_FILE`
expose the public `workspace.workbench.environment/v1` description: configuration
identity, declaration sources, preparation state, verified tool versions, executable
path entries and cache variables. `prepare: false` only inspects. Consumers should
use this description or inherited variables, never private runtime records or
storage layout. The descriptor is not an authorization token and contains no
secrets. It is refreshed on a new session/open operation; existing processes retain
their own environment.

## Workspace sources

The selector automatically shows a collapsible tree when creation bases identify
one parent Workspace. Independent Workspaces stay as ordinary rows. Search retains
ancestor context; "Select group" includes only eligible matches in the current
filter, including collapsed descendants. Deleting a parent does not cascade.

Creation resolves actual Git references and matches local branch ownership within
the registered project. All selected repositories must identify the same unique
Workspace. A shared commit, a common main branch, ambiguous ownership or mixed
sources do not establish a parent. The resulting identity and resolved SHAs are
journaled before Git mutations and reused during recovery, even if the parent moves.
Existing records with saved base branches use metadata-only matching and require
the parent record to predate the child; a newer same-name Workspace cannot adopt
an old child. No Git history scan or record rewrite runs while browsing the list.

The optional `parentWorkspaceId` on create, preview and submit remains a shortcut
for creating directly from a flat Workspace's committed HEADs. Omitted repositories
use its scope; explicit `baseRefs` retain configured-source Git reference semantics.
Uncommitted files are not copied. Workflow checkpoints freeze repository scope
before handoff. `sourceWorkspaceId` retains its separate Gitlink meaning; do not
provide both fields. Neither field binds a session exclusively to a Workspace.

Provenance uses optional schema-v1 fields and immutable creation identities. Old
records and their unknown fields remain readable. Sources are captured by creation;
the UI does not require manual classification or display an unclassified category.

### Lightweight handoff and creator filtering

`workbench_workspace_create` creates Git worktrees without starting an Agent.
When a new execution session is explicitly requested, `workbench_workspace_submit`
exports the current Paseo chat text and freezes it for that request. This uses the
host's history export capability; it is not a native model-session clone. A host
without this capability returns a handoff error while Git-only creation remains available.
The existing execution-policy gate currently verifies Codex only. Claude can
consume host-exported history, but Workbench does not yet certify its independent
planning state and therefore does not dispatch a Claude execution handoff.

Supply required images/files through `references` using registered `assetId` values
or source-repository paths. `originalPaths` remains supported for originals inside
a source repository. Originals are frozen before dispatch; missing or oversized
references stop the handoff before Agent creation. Images are sent as native image
inputs and other originals remain readable through the existing handoff tools.
The result identifies the supplied sources; it never claims that historical
attachments or full tool outputs were automatically copied. Retry/status uses the
same request identity and never automatically resends an uncertain delivery.

Workspace records optionally retain their creator session. Every panel entry
provides **Creator session**, combined with search and active/history filters.
When the host supplies an explicit current session it is offered as a shortcut;
workspace and global entries can select any creator recorded in the project. Creation attribution is independent of execution bindings and parent
Workspace provenance. Retries and later sessions do not replace the creator;
legacy records without attribution remain visible in the full list.

## 改动说明

Agent 可为固定比较范围批量提交修改原因、需求依据和行为变化，在文件列表及 Diff 中查看；疑问保存在本地并可复制给当前会话。使用方式与边界见 [CHANGE-NOTES.md](CHANGE-NOTES.md)。

## Compare 连续阅读

在 Compare 的文件列表点击文件，会在主区域打开固定 SHA 范围的「整组差异」并定位到该文件。文件筛选同时作用于导航列表和连续阅读，固定 SHA 比较身份与原始改动范围保持完整。每个文件标题可折叠，也可「单独打开」到原有文件标签。单提交和未提交变化仍使用单文件阅读。

变化文件标题栏保留说明入口、文件数、单个树形／列表切换按钮和「…」。在「…」的集中浮层中，可设置包含／排除路径、文字／路径模式、测试文件显示方式及说明状态；修改即时生效，不增加常驻搜索行。说明图标进入同一浮层的说明状态选项。

测试文件首次默认弱化：文件名与连续 Diff 标题使用次要颜色并显示「测试」标记，代码、变化状态及增删行颜色保持可读。也可选择全部显示或隐藏；隐藏项不参与连续阅读及文件导航，已经单独打开的文件标签仍可查看。无匹配结果时可清除筛选并显示全部。

显示方式及项目识别规则仅保存在本机当前项目，同项目各 Workspace 和比较入口共用；包含／排除及说明状态按 Workspace、仓库及提交／比较上下文保留会话状态，重新加载页面后不恢复搜索。项目识别规则支持启停 Go、Python、JS／TS、Java／Kotlin 预设，追加测试路径规则，以及优先按普通文件显示的例外。无法确定的文件正常显示；名称中的 `test` 子串不会单独触发分类，测试数据、快照和示例不因关联名称而自动隐藏。

文字模式对新旧路径做不区分大小写的包含匹配；路径模式按大小写支持 `*`、`**`、`?`，其中 `**` 独占一级目录且可匹配零级或多级目录。无 `/` 的规则匹配任意层文件名，有 `/` 则匹配仓库相对路径。包含与排除同时生效，排除优先；测试分类按重命名后的新路径判断。无效规则会提示并保留上次有效结果。识别及筛选使用已有改动路径，不额外扫描目录，不改变 Agent 审核范围。

默认显示修改前后各 3 行上下文。省略区可逐次展开 20 行或展开该段；点击文件路径可展开／收起当前文件的全部上下文。补充内容来自固定版本的 Git blob，不读取当前工作树；二进制、子模块、截断补丁及超出文件字节限制的内容保持明确提示。

整组使用一个虚拟列表，优先读取可见文件及前后各一个文件，正文／上下文最多同时读取两个任务。上下文响应最多 200 行、64KiB，仍受项目 `maxDiffBytes` 限制；非活动正文缓存预算为 8MiB。说明继续使用原补丁身份，展开不会修改说明的定位依据。

验证入口：`node paseo-plugin/scripts/verify-continuous-diff-ui.mjs`。它创建隔离 Paseo 宿主、项目及通用 Git 样本，覆盖连续阅读、上下文、说明跳转、失败／迟到响应、缓存切换和响应式布局；不会重载日常插件。网页验证不能替代 Android/iOS 原生设备验收。

Diff 右侧概览支持点击色块定位修改、点击空白轨道定位文档，以及抓住滑块连续拖动；鼠标移出轨道后仍可继续拖动。操作区在桌面为 24px、原生端为 44px，内部色条保持细线外观。聚焦后可用方向键、Page Up／Down、Home／End，Esc 结束拖动。拖动期间暂存新内容与行高变化，松手后保持代码锚点并更新布局。

滚动像素位置由独立信号更新，文档与布局按内容变化缓存。`scripts/verify-diff-scroll-ui.mjs` 使用隔离宿主和临时源码副本记录 200 文件／20,000 行样本、长文件及稳定内容滚动的帧耗时、长任务、挂载行数与重建次数；诊断计数仅注入临时副本，不进入生产插件。原生手势模拟与真实设备性能验收分别记录。

## Workspace 文件工作台

在当前 Workspace 选择器下打开「文件」Tab，可拖拽上传文件和目录、操作远程文件树并查看独立传输队列。支持跨空间复制粘贴、ZIP64 下载与持久任务恢复。使用、平台保存能力与清理规则见 [FILES.md](FILES.md)。

## 缓存与空间

Workspace 选择器默认列表视图，按最近提交倒序排列，主工作区参与相同排序。
可切换来源层级视图，按组内最新提交排序，累计缩进最多 24px。视图选择沿用宿主设置保存。
项目加载名册后在后台维护提交快照。打开选择器立即使用已有排序，并提高当前选用和可见 Workspace 的检查优先级。
已监听到的 Git 引用变更优先核对，其余按活跃程度轮转。当前选用每 15 秒、可见项每 30 秒、近一天使用或提交的项每 2 分钟、近一周每 10 分钟、更早每 30 分钟核对。HEAD 未变时复用提交时间。
每个 Workspace 的本批仓库检查结束后合并更新，保留选择和可见行位置。普通刷新补检查到期项，“…”菜单中的“全量检查提交”会重新核对项目中全部仓库，可查看进度或取消。空间统计独立安排。

“缓存与空间”沿用工作台的紧凑分组行，展示统计摘要、全局缓存、项目缓存和 Workspace 目录。
当前仅注册 Go 提供者，区分编译缓存、模块缓存，以及全局、项目共享和 Workspace 独占目录。
发现路径来自生效的 `go env`、现有运行时缓存规则、环境快照和保留的托管目录；不会安装工具链或迁移缓存。
项目编译缓存的 Go 版本／平台子目录会形成固定目标集合，预览逐一列出。

打开缓存页立即显示已有值，只在页面使用期间按需补统计到期项；关闭后完成当前目录并暂停剩余队列。
Workspace 按最近提交、实际使用及已知代码／准备活动安排统计：24 小时内活跃为 10 分钟，
1～7 天为 1 小时，7～30 天为 1 天，更早为 7 天；当前使用的 Workspace 按活跃项处理。
未知活动的目录首次统计后按 1 天处理。全局缓存为 30 分钟，项目共享缓存参考引用者，间隔为 10～60 分钟。
刷新只更新到期项；“全量重新统计”跳过有效期，重复请求合并。每个目标独立保存结果，暂停或重启后复用已完成项。
选择器只读取快照。占用按磁盘已分配字节估算，不跟随符号链接，硬链接、重叠路径及共享缓存去重。
缓存合计与 Workspace 目录合计分别显示；主工作区目录排除工作台的状态、缓存与隔离 Workspace 根目录。
权限不足、超时和部分完成保留上次成功值与时间，并延迟重试；不同时间的合计标为估算。
APFS 克隆、压缩和写入中的文件会使估算与实际释放量存在差异。

手动清理先预览类型、路径、共享影响范围和估算占用，再使用持久化请求身份启动后台任务。
编译缓存仅设置选中目录的 `GOCACHE` 并运行 `go clean -cache`；模块缓存仅设置 `GOMODCACHE` 并运行 `go clean -modcache`。
两个操作独立，不提供按天清理、自动清理或自定义删除回退。已知准备、执行或审核任务正在使用缓存时禁止清理。
重启后的未完成清理记为中断，响应丢失后查询原任务，不自动重放。
空间扫描期间仍可查看结果、展开详情和提交清理。清理请求优先，跨项目扫描会在安全检查点让出执行；
清理后只使实际受影响的路径统计失效，旧扫描结果不能覆盖清理后的状态。

通用协议为 `cache.list`（快照及逐项更新时间）、`cache.scan`（启动／取消、页面暂停、实际使用活动）、`cache.task`（进度和操作凭据）及
`cache.cleanup`（预览／启动）。操作只接受服务端目标 ID，不接受任意目录或命令。
快照、预览和任务存放在 `stateRoot/cache-management/`，不修改 schema-v1 Workspace 记录。
同一宿主通过 `PASEO_HOME/workspace-workbench/cache-management/operations.sqlite` 对单个统计单元及清理互斥，
独立的控制数据库登记清理优先请求和路径失效版本；请求租约过期不会重放清理。
目录遍历采用异步文件读取，并为交互 Git 请求让出执行机会；统计与读取快照不会刷新活跃时间。

新增工具时实现 [`CacheProvider`](server/backend/cache-provider.ts)，在 `CacheManagement` 注册：
声明提供者／类型标签、范围、实际根目录、Workspace 引用及可用操作，并用工具原生命令执行清理。
聚合目标的每次命令执行前调用 `context.validateCleanup`，成功后调用 `context.cleanupProgress`。
公共层复用计量、任务、快照、预览、身份校验和去重；页面根据标签和操作能力渲染，不限定 Go 类型。
Node、Gradle／Android、Java 等尚未实现，接入时必须补充提供者契约测试。

验证：`npm --prefix paseo-plugin run typecheck`、`npm --prefix paseo-plugin test`，以及
`node paseo-plugin/scripts/verify-cache-ui.mjs`。UI 脚本加载真实插件至隔离 Paseo 宿主，使用临时 Go 缓存，
检查列表／层级、最近提交、清理预览及浅色／深色／390px 面板，不操作日常宿主或注册表。

## 档案话题

每个项目都显示“话题”页签，未启用时可在页内连接 AI 助手并启用，也可从“…”→“扩展管理”进入。
服务地址、Token、既有资料库和关注群按项目保存；停用不会移除页签或清空关注群。
没有关注群时，页内入口直接打开关注设置；群筛选只列出该项目已关注的群。
“话题”页按方案 C 提供多选列表、原文与媒体展开区、底部材料区。点击话题只读取该话题关联的资料；
上下文须主动打开，默认每个锚点最多返回附近 41 条。列表每 20 秒在页面可见时刷新，选材范围不随刷新扩大。

标题沿用档案工作台的标题规则；正文和上下文显示实际文字及媒体，不重复显示传输占位串。
当天显示时间，跨天显示日期与时间，跨年带上年份。

选择消息会一并选中已就绪、可交接的附件，在底部显示缩略图；原文与附件仍可独立移除，已有分析默认不选。
点击“发送到会话”打开确认窗口，统一预览材料、补充可选的本次说明并选择会话；确认前不会发送或创建空会话。
可沿用当前项目已有会话的模型，也可新建会话并从当前主机可用的模型中选择。新会话沿用宿主默认设置，成功后可直接“打开会话”。
说明只属于本次材料，关闭窗口保留草稿，清空材料后清空说明；最多 8000 字，不保存为固定提示词。
发送前固定话题修订、消息版本及附件原件，原始消息另存于私有快照以便核对。
会话正文只包含本次说明与明确选择的文字，不自动加入话题标题、群来源、消息 ID、校验值或检索指令。
原图通过宿主图片输入交付，并在会话中显示可打开原图的图片预览；重载页面后仍可查看，不依赖接收模型回群取图。
相同图片原件仅发送一次。新会话先固定创建结果，再使用普通消息路径发送所选文字与图片。
原件沿用宿主支持的图片、PDF 和文本格式，单件最多 8 MiB，
附件合计最多 24 MiB；不支持或未就绪的原件标明状态。普通会话直接发送完整文字；旧 Workbench 会话的超长原文以完整 Markdown 原件交接，不静默截断。
宿主接收与模型阅读分开；投递或创建结果未知时只查询同一回执，不自动重发或重复创建。

DWS、采集、来源和话题整理模型都在独立 AI 助手服务维护；发送窗口的模型选择只作用于新建的宿主会话。
Workbench 的简单设置只选择资料库与群，
并可经服务 API 设置逐群“自动建题”（collect / reply off）及已注册工具授权。关注范围与服务建题策略是独立操作。
旧扩展 ID、连接字段、API-v1 SDK、候选与需求历史保持兼容。打开新界面不会注册新的采集项目。

默认地址为 http://127.0.0.1:47191；默认 Token 由后端从 AI_ASSISTANT_HOME、COMMUNICATIONS_HOME
或 ~/.project-communications 读取，自定义连接使用 HTTPS。凭据不返回浏览器，也不写进项目配置。
服务和数据的生命周期独立于 Workbench。接口适配及实施说明见 [话题设计](../docs/design/archive-topics/README.md)。
