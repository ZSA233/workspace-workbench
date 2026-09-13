# Workspace 演进执行记录

已核对 workspace-evolution-20260914 的 worktree、分支及基线 f20df08。
运行时：Node 22.22.1、Python 3.11.9；项目没有 toolchain 配置。

阶段一：在现有 provider 操作锁内增加仓库扩展日志，先验证全部输入，逐库创建并持久化，超时核对 Git 身份，失败保留现场以便重试；原 ID、历史和已有仓库保持不变。插件入口检查执行/审核状态，新增仓库通过现有 prepare 和后续 handoff/runtime 协议使用。

阶段二：沿 JSON 行协议迁移到 Node，分离配置与记录存储、Git、Workspace lifecycle、runtime/cache、observation、transport、supervisor。保留 schemaVersion=1 的记录和路径规则；进程管理需验证身份、等待退出后回收 socket，覆盖多项目和插件卸载。

每阶段独立测试、临时 Git 仓库验证及提交。实际插件加载与测试替身验证分别记录。

## 追加授权：计划/执行模式一致性（2026-09-14）

原冻结 handoff 不改写。本节作为补充验收依据；现有 Reviewer 以冻结 reviewPacket 为输入，不自动覆盖新增验收，完成报告须明确请求补充审核。

诊断：execution-policy.ts 混合 provider、权限 modeId 和 plan_mode；adaptive 默认 false 是新建意图，不代表宿主已同步执行。orchestrator 在异步 catalog/prepare 前取主控快照；agent-provider 在创建后未读子会话实际模式即 send。复用把实时模式与最初 startMode 比较，阻断合法计划→执行转换。UI 固定 adaptive，权限预设显示不应作为执行状态。

实施边界：权限继承只决定权限；主控 actual plan/execute/unknown 决定副作用是否允许；startMode 仅决定首次子会话意图；复用只读当前实际状态，不切换或重投递。创建前、创建后与首次投递前重新读取宿主。plan-first 不自动关闭计划。未知、同步不符、主控计划分别报可操作错误。

SDK 0.8 的 create/send 无模式 revision 或 compare-and-set 参数，客户端复查无法消除最后一次 refresh 到请求生效的 TOCTOU 窗口。必须如实记录此宿主协议限制，不能以测试替身声称原子保证。

追加验收：计划/执行/未知 × adaptive/plan-first × 新建/复用；创建前后切换；重复请求无重复投递；UI 显示宿主实际模式；真实插件会话验证计划不执行、授权切换后可执行；reload 后一致性。与添加仓库、Node 迁移使用同一语义。

### 宿主实证与实际阻塞

只读检查：本机 Paseo CLI/daemon 0.8.0，插件配置仍指向主 checkout `/Volumes/data2/proj/workspace-workbench/paseo-plugin`；未修改或 reload 已安装插件。

已安装 server 的 `codex-app-server-agent.js`：`applyFeatureValue` 立即修改 `planModeEnabled` 和 `resolvedCollaborationMode`（2729–2741），`features` getter 读取该变量（2505 起），而 `turn/start` 请求在 3001 起把模式复制进请求。之后改开关无法证明已经运行的 turn 同步改变。对外 `AgentSnapshot.activeTurn` 只有 turnId、startedAt，没有 effective planning state 或 revision；SDK create/send 没有模式条件参数。

因此活动主控即便快照 `plan_mode:false` 也必须报 `coordinator_active_mode_unavailable`，不能把下一轮配置当作当前实际执行状态。此限制会阻止旧宿主活动 turn 内的 MCP execute；只读 preview/status 和已投递任务的幂等复用仍允许。当前补丁未部署，不能声明真实插件会话验收通过。

需宿主提供：活动 turn 的有效 collaboration mode、模式切换 pending/applied 状态，以及创建/发送时校验 coordinator mode revision 的原子条件。当前授权目录只有 Workbench worktree，不能修改主 checkout 或宿主安装产物。需提供获授权的宿主源码 worktree（或先提供已支持上述协议的宿主版本），再补充审核并完成跨仓库集成。Node 迁移尚未开始，不计为完成。

## 检查点报告

- 添加仓库提交：`1480328`。包含 API/UI、base ref、manifest、逐库恢复日志、runtime prepare、活动任务检查和插件内 scope 串行化。
- Python 回归 40 项通过；随后新增仓库最终检查 5 项通过，均使用临时真实 Git 仓库；故障和超时由 Git adapter 注入，不能冒充生产故障验证。
- 插件完整回归最初 88/89：MCP 工具测试继承了本执行会话的 `WORKBENCH_EXECUTION_REPORT_ONLY=1`，移除该测试环境变量后 89/89 通过。增加竞态、复用和活动 turn 未知状态测试后，相关回归 28/28 通过；typecheck 通过。
- 新增验收采用本补充文档，不修改冻结 handoff；正式 Reviewer 尚未运行，需在后续完成报告中显式补充审核范围。
- 当前限制：只读检查了运行宿主及安装源码，没有真实加载本 worktree 插件，没有创建测试 Agent；因此 UI/宿主真实计划→执行验收未完成。首次投递未知状态保留已有绑定，需检查现有会话，不能自动重投递。
- Node 后端迁移、统一 supervisor、多项目 reload/unload 与孤儿回收尚未实现或验收；没有将 Python 包装器当作 Node 迁移成果。
- 未修改主 checkout、YUVA、历史 Workspace、未跟踪 uv.lock；未自动合并或发布。

下一步需要获授权的宿主独立 worktree 或支持有效模式与原子条件校验的宿主版本，补齐活动 turn 模式协议，再继续同语义的 Node 迁移和真实插件回归。当前执行状态为 needs_input，不是 ready_for_review。
