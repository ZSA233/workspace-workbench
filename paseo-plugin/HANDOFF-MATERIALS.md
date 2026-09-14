# 可追溯交接资料

新交接会在项目的 `stateRoot/handoff-bundles/<id>/<version>/` 中冻结资料。
业务仓库不新增交接文件，首次启动消息只包含目标、位置、资料入口和执行边界。
旧任务继续沿用原交接方式，不自动补造历史。

## 预览与原始资料

`workbench_workspace_preview` 保存资料快照，但不创建 Workspace 或修改 Git。
返回 `materials.bundle`、`ready`、`blockers`、`warnings`、资料数量和会话覆盖情况。
相同请求重试复用同一份资料；修改要求或引用后使用新请求重新预览。
原文在预览后变化，不会改变已冻结的版本。

交接文件包括：

- `HANDOFF.md`：目标、主控理解、用户偏好、决策与理由、范围、计划、验收及待确认项。
- `SOURCES.md`：原始资料出处、必读要求、阅读重点、缺失及格式限制。
- `conversation/*.md`：公开用户消息、助手回复和工具名称/状态，消息编号为 `M<seqStart>`。
- `assets/*`：显式引用的文档、图片及 PDF 原件。
- `manifest.json`：版本、文件摘要和覆盖范围；不是发给模型的启动消息。
- `environment.json`：执行时保存的仓库和运行环境信息。

通过 `handoff.context` 表达带来源的条目，例如：

```json
{
  "goal": "实现符合原始需求的按钮",
  "context": {
    "preferences": [{ "text": "保留键盘导航", "sources": ["M42", "REQ §3"] }],
    "decisions": [{ "text": "沿用现有组件", "reason": "保持交互一致", "sources": ["M48"] }],
    "assumptions": [{ "text": "颜色暂按蓝色理解，需对照原型", "sources": [] }]
  },
  "reviewPacket": {
    "references": [
      { "id": "REQ", "repositoryId": "web", "path": "docs/requirement.md", "required": true, "reading": "重点阅读第 3 节" },
      { "id": "IMG", "assetId": "registered-prototype", "required": true }
    ]
  }
}
```

`context` 还支持 `understanding`、`requirements` 和 `rejectedAlternatives`。
未提供来源的条目标记为“主控整理，未关联原文”。插件不调用模型二次总结，
来源标注由主控填写，原始记录供执行者核对。

会话导出最多 100 页、8 MiB，单份文本沿用 512 KiB 限制，单个附件最多 8 MiB，
总资料包最多 64 MiB，原始引用最多 128 份。超限、历史缺口和导出失败会明确报告。隐藏推理和工具原始
输入输出不归档，可识别的认证凭据做脱敏；不扫描无关文件或自动抓取外部链接。

当前 Paseo 时间线不暴露原始图片/附件元数据。因此资料清单明确显示这个限制；
重要原件须通过 `reviewPacket.references` 指定，不能只依赖聊天中提到过它。
必读资料缺失或过大时不能执行。PDF 原件可保存，但必须提供可读文本或页面图片，
并在 PDF 引用的 `readableAlternativeIds` 中列出替代资料 ID，才能作为必读资料交接。

## 按需读取

原主控、绑定 worker、当前获授权 Reviewer 可使用：

- `workbench_handoff_read`：默认 `HANDOFF.md`；用 `file` 读取 `SOURCES.md`、`DIRECTORY.md` 或指定文件，按返回的 `nextOffset` 继续。
- `workbench_handoff_search`：用 `query` 搜索原始文本和会话，返回文件、位置与片段；搜索的 `nextOffset` 是文件索引游标。
- `workbench_handoff_asset`：用 `sourceId` 获取真实图片内容或分段文本，图片以 MCP image 内容块返回。

`bundle` 为 `{ "id": "预览返回的标识", "version": 1 }`。执行者省略它时读取绑定的
最新版本，Reviewer 默认读取执行报告绑定的版本。读取仅接受清单中的文件，
不能通过工具读取任意本地路径。界面在交接详情中提供核心文档、来源目录和旧版本入口。

文本每段最多 16 KiB，搜索结果有界；完整历史不会自动进入模型上下文。
“已获取”只表示工具返回过资料，不证明模型已经理解。执行前应读核心文档与必读原件，
有疑问时检索历史；执行者可改进实现细节，改变用户目标或明确边界时需找主控确认。

## 补充与审核

新任务的补充消息生成追加资料版本，冻结原文、发送者、时间和附件；旧版本保持不变。
执行会话会收到简短的新版本入口。投递未确认时保留 pending，原请求可核实结果，
不会自动重新发消息；旧完成报告不能越过待确认补充。

新任务提交 `workbench_execution_report` 的 `ready_for_review` 时，必须带
`report.materialsVersion`，且覆盖当前已接受的补充版本。主控与独立 Reviewer
均读取该版本；修复请求沿用它。旧任务不要求新增版本字段。

## 验证

运行 typecheck、handoff-bundles/MCP/交接/审核回归，以及隔离的 `verify-live.mjs`。
`WORKBENCH_LIVE_AGENTS=1` 额外运行真实 Codex：在未提交的原始文档与图片中获取依据，
指出其与主控未确认假设的冲突，再由主控审核。该验证使用临时项目、独立 Paseo home
和独立 registry，模型行为结果与程序测试分别报告。
