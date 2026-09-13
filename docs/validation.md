# Workbench 验证说明

当前公共插件处于并行验证阶段。在实际 Paseo 客户端确认公共版可用前，不停用已有的
其他集成。

## 已实现的边界

| 区域 | 实现与证据 |
| --- | --- |
| 导航 | 全局 surface、Explorer workspace/Agent 面板、workspace header 按钮和订阅清理 |
| 选择 | 保存的选择优先于 identify、managed 路径优先于 live root、筛选隔离、设置冲突重试和偏好通知 |
| 布局 | 导航、仓库、提交图、变化、Review 和 Agent 组件分离；两个可拖拽区域；底部变化区域没有拖拽条 |
| Git | root/merge 提交 Diff、重命名、未跟踪文件、refs 和提交图分页；使用隔离 Git fixture 回归 |
| Review | 真实目标关系、提交数量、重叠文件、问题传递和按仓库说明；覆盖 fixture 勾选与展开 |
| 文件审查 | 带 Workspace/scope 的页签身份、活动页签切换、Split/Unified、语法高亮、overview rail 和 hunk 导航 |
| 缓存 | 有界 L1 和 SQLite 快照、后台任务限制、partial 合并、持久化失效、损坏降级和重启恢复 |
| 生命周期 | 请求身份、进程锁、创建日志、回滚证据、cleanup 预览、dirty/身份拒绝和历史保留 |
| 运行时 | 可选 mise provider、显式 prepare、实际运行时版本校验和 fail-closed 查询 |
| Agent | 可选 capability、持久化 handoff、目录校验、并发请求合并和受保护复用 |

## 可重复检查

```sh
make check
make package
node paseo-plugin/scripts/verify-live.mjs
```

当前自动化检查以 Node/Paseo 为唯一 Workbench 后端，覆盖插件 typecheck、Node/Git、
Supervisor、Workspace 生命周期、审核恢复和 UI/MCP 合同。旧 Python 服务删除前的
协议对照结果保存在 `docs/verification/backend-parity-review-recovery-20260914.md`。
fixture 中的 Git 操作只影响临时仓库。

## 渲染证据与待验收内容

公共组件已经使用固定数据覆盖 420、480、720 和 1440 像素，以及亮色和暗色主题。
已覆盖 Review 选择/说明展开、区域折叠、文件打开、窄面板 Unified 布局和鼠标中键关闭
页签。

这些检查不能替代真实客户端验收。实际 Paseo Explorer 位置、会话切换、Android 原生
渲染、剪贴板、拖拽手势、弹窗宿主高度和客户端重启后的偏好持久化，仍需在真实客户端
确认。Paseo 当前版本没有外层 Modal 尺寸控制 API，因此插件只能调整内容区高度。

隔离 Agent smoke 已验证新建主控 Agent 能获得 Workbench MCP，并实际调用
`workbench_workspace_preview`。没有在现有业务 Workspace 中执行写入或安装真实项目运行时。
