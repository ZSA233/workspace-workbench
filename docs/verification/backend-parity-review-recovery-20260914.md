# 后端对照与审核恢复补充验证

本轮在 `obs/workspace-evolution-20260914/workspace-workbench` 实施；未合并主工作区，未切换日常插件。真实 Paseo 0.8.0 实例直接从本分支目录加载插件。架构仍为插件 TypeScript Supervisor 管理每项目独立 Node worker 与 socket。

## 审核恢复诊断与修复

1. 执行阶段 `needs_input` 导致 blocked，此时没有 snapshot。旧 resume 无条件切 queued/startReviewer，必然抛出 `review_snapshot_unavailable`。新路径验证执行会话身份后恢复 waiting_execution，保留 ID、冻结 handoff 和事件，不创建 Reviewer、不发送执行任务。重复恢复不增加 revision；随后显式完成报告与 turn-ended 可以正常进入待审核。
2. 对终止流程显式重新开始审核会创建新记录，但旧代码漏带 handoff，导致原验收要求丢失。现在携带原冻结 handoff，旧历史保留；新增回归核对 Reviewer prompt 仍包含原 criterion。
3. UI 对恢复后的 waiting_execution 显示等待新报告的说明，也说明执行结束后可手动开始审核。未自动切换计划模式、未自动重发任务。

这两处属于原插件审核状态机，不能归因于 Python/Node 迁移。尚未替换日常实例，旧实例仍有原问题。未直接修改任何正式审核状态文件或冻结 handoff。

## 逐项核对

| 功能 | 本轮及已有验证 | 结果与边界 |
| --- | --- | --- |
| health、项目隔离 | 真实插件两项目独立 PID/socket，Node 实现标识 | 通过；运行时元数据自然不同于 Python |
| list/detail/identify | 同一真实仓库，递归比对 Python 已有业务字段；正常、脏文件、缺失 worktree、移除后列表 | 通过；修正缺失路径的 branch 从 null 为旧协议空字符串 |
| create/add/runtime | Python 记录读取、相同 request hash、保留 ID/历史、Git hook 局部失败、超时后恢复、重复添加、新增仓库进入 runtime | 单元及真实插件通过 |
| prepare、runtime/cache | 原运行时版本选择、缓存、PATH、本地执行回归及 Python 对照 | 通过；旧 SQLite 观察缓存保留，Node 派生缓存重新生成 |
| graph/changes/diff | working/commit/branch、root commit、rename、untracked、二进制及路径边界回归 | 通过；Node 对含 NUL 的 untracked 文件按 binary 分类是有意修正 |
| review-set.compare/brief | 同仓库字段对照及真实面板 RPC | 通过 |
| remove/restore | Python/Node 返回值与列表对照；真实插件 RPC 往返 | 通过；补齐重复 remove 的 activeTasks 空数组 |
| cleanup/delete | 已有安全删除、脏路径/新提交拒绝、失败保留历史回归 | 通过；不复制旧实现的强制删除行为 |
| reload/unload/recovery | 真实插件 reload 更换两个 worker；一个崩溃后请求恢复；disable 退出并回收 socket | 通过 |
| 拒绝行为 | 未知方法、agent 方法、缺失 Workspace、live runtime、不可用 prepare 的错误码对照 | 通过；不是所有非法输入的穷举 |
| Reviewer/handoff 图片 | 状态机恢复、冻结验收、报告生命周期、图片附件、结果验收与原回归 | 受控 Agent 测试通过；未创建真实模型 Reviewer |
| 计划/执行模式 | 原宿主快照矩阵与竞态回归 | 通过；不冒充真实模型模式切换验证 |

对照时只排除时间、耗时、缓存/观察调度元数据，允许新增兼容字段。变更后的 Python 对照先清理**临时测试项目**派生缓存，防止把旧 stale-while-revalidate 快照误当成当前业务结果；正式项目缓存没有改动。不能据这些用例宣称所有行为已经穷举一致。

## 本轮结果

- `npm --prefix paseo-plugin test`：124/124，无跳过。原 MCP schema 测试受会话角色环境影响，现各用例显式指定角色，避免执行会话下误判。
- `PYTHONPATH=src python3 -m unittest discover -s tests`：40/40。
- `npm --prefix paseo-plugin run typecheck`、`git diff --check`：通过。
- `node paseo-plugin/scripts/verify-live.mjs`：真实 Paseo 加载、8 类面板 RPC 与 Python 业务字段对照、移除/恢复、双项目 reload/unload、崩溃恢复全部通过。临时根目录 `/private/tmp/wb-live-46t0Pm` 已清理。
- Node 测试运行时 22.22.1；真实 Paseo daemon 22.14.0。Python 只用于兼容性验证，不参与正式后端启动。

真实验证通过面板所用公共 RPC 调用，未操作浏览器渲染 UI；Reviewer 状态机测试使用 Agent 替身，不代表真实模型会话审核已经通过。当前用户限制不创建额外 Agent，本轮遵守该限制。

## 补充审核要求

本文件追加验收，不修改冻结 handoff：核对无快照恢复、重复恢复无投递、终止后重启保留 criterion、错误身份拒绝、原安全边界及协议差异。正式 Reviewer 结论仍待获取。此前终止流程的晚报告拒收不应通过直接改文件绕过；新版正常恢复入口生效需要相应实例加载本分支插件。

实现提交：`c9a1253`。提交后再次调用 `workbench_execution_report(ready_for_review)`，旧实例仍以 `execution_report_late` 拒收。返回的正式历史确认用户两次恢复均因 `review_snapshot_unavailable` 失败，当前状态为 failed、round 0、snapshot null，与本轮修复的根因吻合。这是旧实例的实际记录证据；不代表新版真实 Reviewer 已经验证。
