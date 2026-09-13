# Workspace 演进执行记录

已核对 workspace-evolution-20260914 的 worktree、分支及基线 f20df08。
运行时：Node 22.22.1、Python 3.11.9；项目没有 toolchain 配置。

阶段一：在现有 provider 操作锁内增加仓库扩展日志，先验证全部输入，逐库创建并持久化，超时核对 Git 身份，失败保留现场以便重试；原 ID、历史和已有仓库保持不变。插件入口检查执行/审核状态，新增仓库通过现有 prepare 和后续 handoff/runtime 协议使用。

阶段二：沿 JSON 行协议迁移到 Node，分离配置与记录存储、Git、Workspace lifecycle、runtime/cache、observation、transport、supervisor。保留 schemaVersion=1 的记录和路径规则；进程管理需验证身份、等待退出后回收 socket，覆盖多项目和插件卸载。

每阶段独立测试、临时 Git 仓库验证及提交。实际插件加载与测试替身验证分别记录。


阶段一验证：Python 回归 40 项通过；添加仓库 5 项临时真实 Git 用例通过；插件完整回归 89 项通过（去掉执行会话继承的 WORKBENCH_EXECUTION_REPORT_ONLY 环境变量）；TypeScript typecheck 通过。实际安装插件指向主 checkout，未加载本 worktree，真实插件 UI 验收仍待完成。
