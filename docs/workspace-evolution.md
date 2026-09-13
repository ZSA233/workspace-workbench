# Workspace 演进：实现与审核记录

## 最终架构

```text
Paseo 插件（TypeScript Supervisor）
├── 项目 A Node.js 后端 ── 项目 A Socket/配置/记录/缓存
├── 项目 B Node.js 后端 ── 项目 B Socket/配置/记录/缓存
└── 项目 C Node.js 后端 ── 项目 C Socket/配置/记录/缓存
```

每个 canonical 项目配置路径对应一个独立进程。插件统一启停、reload/unload 和异常恢复，
没有合并成共享业务后端。正式运行需要 Node.js 22.14+ 和 Git，不依赖 Python 环境。
SQLite 项目锁使用 Node 内置模块，不安装原生 npm addon。已安装 Paseo 的 Node 22.14.0
实际验证支持该模块。

## 分阶段实现

1. `1480328`：已有 Workspace 添加已登记遗漏仓库，支持 base ref、逐库日志、manifest
   同步、幂等重试、运行时准备和 UI 入口；活动执行/审核与范围变更串行化。
2. `5e77a94`：纠正早期过度保守的模式判断。权限、启动意图与宿主计划开关分离，不因
   running 就一律阻止；创建和投递前重新核实，复用不受初始模式永久约束。
3. 本次 Node 迁移：配置/存储、Git、Workspace lifecycle、runtime/cache、observation、
   review-set、transport 和 supervisor 分模块实现，生产入口与打包流程移除 Python worker。
   Python 源码仅保留兼容与测试对照用途。

配置、schema-v1 记录、ID、原仓库、会话及审核历史不自动改写。既有运行时准备 JSON 和
Go/NPM/pip 项目缓存直接复用；可重建的观察缓存改为有界 JSON 存储，旧 SQLite 文件保留。
NUL 未跟踪文件改为二进制分类，这是对旧文本计数错误的显式修正。

## 验证证据

- Python 全套回归：40 项通过。
- Node/插件全套回归：120 项通过；覆盖真实 Git 的新旧协议对照、
  根提交/rename/二进制/路径边界、运行时文件复用、共享缓存、并发与部分观察刷新、
  handoff 图片和 Reviewer。
- 真实 Node 进程验证：多项目与同请求并发、跨 generation 回收、错误 token 拒绝、
  不误杀无关 Unix 服务、崩溃恢复、无 Python PATH 启动、父进程初始化期间退出、
  处理中排空、旧 Python 精确身份回收、同记录目录多 socket 写入阻止及所有权写入失败恢复。
- 实际 Paseo 0.8 插件加载：`node paseo-plugin/scripts/verify-live.mjs`。使用独立 home、
  独立 registry、两个临时真实 Git 项目。真实 post-checkout hook 故障造成部分添加，
  重试恢复并保留 ID/创建时间；新增仓库进入 runtime/handoff；实际插件 reload 替换两个
  旧 PID 并保留记录；单项目 SIGKILL 后请求恢复；实际 disable/unload 退出所有 worker 并回收 socket。
- 实际加载曾发现 Paseo 禁止插件 import backend/ 源码，因此实现归入允许的 server/backend/；
  修正后真实加载通过。测试曾暴露启动时遗漏 IPC disconnect，现已通过专门父退出测试修正。
- 删除审核发现“先删历史、后删 worktree”会在安全拒绝时丢失记录，已调整顺序；
  preview 被阻止或 Git 删除失败都不清理会话与审核历史。
- TypeScript 类型检查、版本一致性、npm 包内容和发布形态压缩包检查通过。

以上实际插件验证没有创建新的执行 Agent；模式切换场景由受控宿主快照/竞态测试覆盖，
不能冒充模型会话复现。按用户后续说明，不以偶发现象必须复现为实施前提。

## 追加模式需求与补充审核

追加需求记录在本文件，不修改冻结 handoff/reviewPacket。正式审核应额外检查：
计划/执行/未知与启动意图、新建/复用矩阵；创建前后模式改变；重复请求不重投递；
权限展示不冒充执行状态；plan-first 不自动执行；Node 迁移沿用同一语义。
原 handoff 的 AC-1 至 AC-6 仍适用。

## 边界与交付

- 没有修改 Paseo、主 checkout、YUVA、历史失败 Workspace 或未跟踪 uv.lock。
- 没有自动合并、发布或替换日常使用的插件；真实验证只使用隔离 daemon。
- 宿主 SDK 不支持原子的模式条件 create/send，因此最后一次检查之后的宿主模式变化仍是
  协议竞态；不通过自动关闭计划模式或修改宿主来规避。
- 无法验证身份的外部/旧后端保留并报错；自动旧 Python 回收只支持可精确核实的本地
  `-m workspace_workbench serve --config`。外部 systemd/launchd 不应与插件同时监督同一项目。
- 删除保留脏 worktree、新提交、未知文件和分支。删除完成但历史清理失败时返回明确错误，
  不将其伪装成 Git 删除未发生。
- 正式 Reviewer 流程由 ready_for_review 报告交接；本记录包含实现自审与回归，不冒充已获 Reviewer 批准。

机器可读验证摘要：[workspace-evolution-20260914.json](verification/workspace-evolution-20260914.json)。

## 审核交接状态

实现提交为 `7f5f82b`，工作区已完成全部实现与验证。已调用正式报告接口提交
`ready_for_review`，但被以 `execution_report_late` 拒收：前一次 `needs_input` 已将旧流程
结束为 blocked。未绕过终态保护或直接修改审核状态文件。现有公开审核启动接口要求执行
Agent 没有活动 turn，因此应在本回合结束后，通过 Workspace 的恢复/重新开始审核入口继续。
此项是审核流程交接限制，不是 Node 重构未完成；正式 Reviewer 尚未给出结论。
