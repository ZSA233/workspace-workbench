# 生成方式与最终提示词

使用内置 `image_gen.imagegen`，没有使用 CLI 或外部图像 API。每个方案单独调用生成，再对已查看的初稿做定向编辑。输出均为不透明 PNG。

## 参考与初稿约束

- Git 面板：`docs/verification/pocket-sidebar-0.1.12/browser-workbench.png`。
- 当前主题：上一轮隔离 Paseo 验证的 `/tmp/workbench-adaptive-cache-ui-final/cache-light.png`。
- 制作约 1800 × 1200 的横向交互概念板；实际输出尺寸以 PNG 为准。
- 保留现有插件工作区选择、标签栏、仓库、提交图和紧凑文件行。
- 标题栏保留说明入口、文件数；将树形／列表改成一个切换图标，用省出的位置放“…”。
- 同时展示关闭与打开菜单／浮层的状态，附单提交和分支比较入口的示意。
- 示例数据为 32 个变化文件，其中 12 个为测试文件。弱化模式保留测试行并标记；隐藏模式显示 20 / 32。
- A：菜单内三态测试显示，搜索与筛选另开浮层。
- B：一个浮层集中放包含、排除、文字／路径模式、测试三态与说明状态。
- C：菜单打开搜索浮层；生效条件通过一行可清除的标签持续显示，无条件时不占行。
- 保留正常代码可读性以及 A/M/D、增删行的颜色语义，不重做主布局。

## 最终定向修订提示词（原文）

### A

```text
Edit this existing concept board with ONLY these two precision corrections. Keep all layout, compact sizing, file list data, light theme, text labels, and panel positions identical. (1) In each changed-files header, replace the incorrect circle-question-mark icon immediately left of '32 文件' with a simple thin gray speech-bubble outline icon, consistent with the existing explanation filter. (2) In the lower-right floating search inset, the inputs contain glob patterns internal/** and **/vendor/**, so select the radio '路径模式' in blue and leave '文字' unselected. Do not alter other text or controls. Keep title A · 菜单优先 and all UI dimensions.
```

### B

```text
Edit this existing concept board with ONLY a text correction. Preserve all screen positions, compact UI sizing, light theme, controls, and the file lists exactly. In the floating 文件筛选 panel, the section label above the 全部改动 dropdown must read exactly '说明状态' (four Chinese characters: 说 明 状 态). It currently has a malformed character. Replace that heading clearly. Do not change any other part of this concept board.
```

### C

```text
Edit the existing concept board, preserving its exact light theme, compact engineering-tool styling, C title, two-panel arrangement, graph, and single toggle + ellipsis interaction. Correct inconsistent filter states and narrow-row layout:
1. BOTH main panes have test mode 隐藏 active. Remove ALL visible test-file rows from the RIGHT pane just as they are already absent in the left. Both panes should show only the excerpt internal/cache/manager.go, internal/cache/schedule.go, scripts/report.py, go.mod, README.md. Keep their normal M/A and green/red line-change indicators. Never show a filename ending _test.go or tests/test_report.py in either hidden-mode list.
2. BOTH header counts read '20 / 32'. BOTH panes have one slim conditional summary row under the header. To fit narrow panels, summary row contains ONLY two small removable chips '隐藏测试 ×' and '排除 vendor/** ×', plus a small clear/reset icon at far right. Put the text '已隐藏 12 个测试文件 · 显示全部' in a small footer directly under the file list, not on the same chip row. Remove extra footer '共32个文件' if it duplicates this information. This is only an excerpt of 20 visible of 32 total.
3. The right anchored ellipsis menu remains as is, with 搜索与筛选…, 测试文件：隐藏, 说明筛选, 项目识别规则…, 清除筛选. Keep the separate floating search illustration on the right with 隐藏 selected, matching the state.
4. In the bottom dark-theme inset use the title '提交 e91c8f2' for the single-commit header (not 未提交变化), and 'origin/main → feature/cache' for branch comparison. Both counts must be '20 / 32'. Each dark summary row contains only the TWO removable chips and a reset icon, no long trailing text, so it never overflows narrow panes.
5. In the top right explanatory text, replace the sentence about counts if needed with '筛选生效时显示一行条件摘要，隐藏数量在列表下方提示。' Keep labels accurate and readable.
Do not add more buttons or introduce a permanent search row. No unrelated redesign.
```
