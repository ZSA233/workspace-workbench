# Workspace 文件工作台交付与验证

日期：2026-10-22。使用说明见 [FILES.md](../paseo-plugin/FILES.md)。

## 已实现

现有 Workspace 选择器下新增「文件」Tab，原来的 Git 页仍为默认页。文件树直接切换主工作区与各 Workspace，显示真实目录和未跟踪文件；按需展开、分页、虚拟化，各空间记忆选择、展开与位置。

支持系统文件／目录拖入、悬停展开与目录落点、上传选择器、树内移动和 Ctrl 复制、多选、右键菜单、快捷键、跨空间复制／剪切粘贴、新建目录、重命名和确认后永久删除。内部元数据与已登记根目录受保护；同名冲突提供跳过、保留两份与替换，并区分单项确认和显式批量选择。目标产生新修改时重新确认。

上传、下载、ZIP 和文件操作使用独立持久任务。队列跨 Tab 保留，显示所属空间、路径、字节、速度和状态。任务固定原 Workspace 实例；上传落盘确认、重复分块核对、最终提交结果查询、原文件重选校验、下载版本检查和 OPFS 恢复均已接通。最终保存流关闭成功后才确认完成，符合 [File System Access 写入提交语义](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable)。

生产后端保持 TypeScript 模块分工，内容走现有认证连接。使用 512 KiB 分块和两个文件的并发预算，不设置业务层文件大小上限。目录／多选通过 yazl 流式生成 ZIP64。Pocket 增加独立可信来源保存桥，使用 Android 系统文档选择器与有界写入。

现有每项目 JSON 观察缓存保留 500 条／32 MiB 的默认边界，补齐 Workspace 实例、共享仓库归属、成功移除后的回收与迟到结果隔离。提交时间索引、目录监听和客户端派生状态参与清理；删除失败保留现场与运行历史。未完成文件任务阻止移除空间。任务日志独立于普通缓存，终态默认保留七天、最多最近 1,000 条，未完成和清理失败的恢复内容不会按此淘汰。

## 验证结果

| 验证环境 | 结果与证据范围 |
| --- | --- |
| 插件 TypeScript | `npm --prefix paseo-plugin run typecheck` 通过。 |
| 完整 Node 回归 | **660 项通过，0 失败、0 跳过**。包含协议、运行时、缓存、Workspace 生命周期、handoff-image 和 Reviewer。 |
| 文件专项 | **19 项通过**。覆盖持久分块、重启、提交响应丢失、冲突再次确认、单项／批量权限、路径保护、跨文件系统移动、源变化、清理与迟到结果。使用真实临时 Git 仓库；故障场景包含受控注入。 |
| 实际 Paseo 宿主 | `verify-files-ui.mjs` 启动 `verify-live.mjs`，在隔离 home、注册表及临时 Git 仓库中加载实际插件。宿主 **19 项检查通过**，包含真实插件重载、后端崩溃恢复、移除／恢复、永久删除保护与卸载回收；100 次注入的宿主连接关闭后成功恢复。 |
| Chromium／macOS | 实际宿主页面 **15 项交互检查通过**，页面错误为 0。保存目标使用实际 OPFS 文件句柄替代原生选择器。 |
| Pocket 构建 | `testDebugUnitTest`、`lintDebug`、`assembleDebug`、`assembleDebugAndroidTest` 通过；**41 项单元测试通过**。 |
| Pocket Android 模拟器 | 独立 QA 安装中运行 `FileSaveDeviceTest`，**1 项设备测试通过**：可信页面打开实际 Android 系统保存选择器、写入并关闭文档，回读内容匹配，删除测试文档。它验证保存桥，不代表 Windows 或 Android 真机端到端传输验收。 |
| Windows Paseo 实际客户端 | **待实机验收**：当前执行环境为 macOS，未取得 Windows Explorer 拖入、原生保存与关闭客户端后恢复的实际证据。 |
| Android 真机及其他浏览器 | **待验收**：Pocket 与远程宿主的真机上传／断网续传、Chrome／Edge／Safari／Firefox 各自版本和部署来源的能力组合。 |

Chromium 的 15 项检查包含：外部文件落点、悬停目录展开、键盘复制粘贴、保存关闭失败保留暂存、ZIP 保存、目录选择保留层级、树内实际拖动、Windows Ctrl 复制事件路径、重命名与删除确认、跨 Workspace 粘贴、其他 Tab 的传输摘要、切换空间后上传目标固定、刷新后上传重选原文件、刷新后 OPFS 续传，以及同源宿主 token 下载。

Windows Ctrl 复制在 macOS 上通过合成带 Ctrl 的 DragEvent 验证。目录上传使用真实浏览器目录选择器；外部文件拖入使用 DataTransfer／File，树内移动使用浏览器实际拖动。以上不会替代 Windows Explorer 实际拖拽验收。

浏览器上传刷新测试在第一个分块持久确认后中断本地读取；刷新后保留同一任务 ID，重新选择原文件并完成校验、续传及内容比对。下载刷新测试在 OPFS 分块和进度记录成功关闭、服务端尚未收到 ACK 时刷新；恢复后的首个读取偏移为 524,288，最终导出完整文件。

## 超过 4 GiB 的实测

`verify-files-large.mjs` 使用真实文件服务和临时 Git 仓库，以 `--max-old-space-size=192` 运行。此处是本机 Node 文件服务测量，不是 Windows 客户端或远程网络的吞吐测量。

| 项目 | 结果 |
| --- | --- |
| 文件大小 | 4,294,967,333 字节，超过 4 GiB。 |
| 上传 | 所有分块持久确认，最终文件完整 SHA-256 匹配；54,950 ms。 |
| 下载 | 所有分块逐一校验；9,616 ms。 |
| ZIP64 | 归档 4,294,967,703 字节，单条目也超过 4 GiB；Python `zipfile.testzip()` 校验通过；24,061 ms。 |
| 内存 | 基线 RSS 117,096,448 字节，峰值 214,106,112 字节（约 204 MiB），增长约 92.5 MiB。文件内容没有整份进入内存。 |

## 恢复与清理检查的边界

测试覆盖重复请求、确认丢失、提交结果丢失、客户端刷新、文件后端重建、磁盘不足注入、目标／源版本变化、保存关闭失败、共享缓存归属、无效清单不触发删除、相同 ID 的新实例及迟到结果。磁盘不足采用受控 ENOSPC 注入；未填满用户磁盘，也未通过断开用户网络制造故障。

浏览器能力按实际 API 检测：安全存储和保存接口可用时使用 OPFS；不具备能力时尝试经过同源宿主身份核对的浏览器下载。后者状态明确为“交由浏览器下载”，不伪造保存完成或精确进度。下载源变化会停止并要求重新选择，避免拼接不同版本。Pocket 本版只保证前台协议恢复，没有新增后台常驻服务。

占用信息是传输 `.part` 内容与派生缓存的逻辑字节数，不等同于文件系统分配量、空闲容量或原子提交瞬间的总磁盘峰值。OPFS 配额与目标磁盘空间仍取决于运行环境；不足时保留恢复任务。

## 复现与产物

```sh
npm --prefix paseo-plugin run typecheck
npm --prefix paseo-plugin test
node --experimental-strip-types --test paseo-plugin/tests/files*.test.ts
node paseo-plugin/scripts/verify-files-ui.mjs
node --experimental-strip-types --max-old-space-size=192 paseo-plugin/scripts/verify-files-large.mjs
```

Pocket 使用项目的 JDK 21／Android SDK 配置，在 `android-app` 执行：

```sh
./gradlew -PpocketTestPackage=dev.paseo.pocket.qa \
  testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest
```

测试产物在本机忽略目录 `.local/verification/files/`：

- [文件树与传输队列截图](../.local/verification/files/files-tree-and-transfers.png)
- [浏览器交互报告](../.local/verification/files/files-ui-report.json)
- [隔离宿主实际插件报告](../.local/verification/files/files-ui-host.log)
- [大文件报告](../.local/verification/files/files-large-report.json)
- [完整 Node 回归日志](../.local/verification/files/node-tests.log)
- [Pocket 构建、单元与设备测试摘要](../.local/verification/files/android-report.json)

正常 Paseo home、正常项目注册表和正常插件未被重载；验证用宿主与 QA 模拟器使用独立状态。

## 紧凑布局调整

桌面文件树调整为 22 px 行高、12 px 文件名字号、12 px 层级缩进，筛选框并入工具栏，底部状态栏缩窄。传输摘要缩窄，展开队列最多占 180 px，并随窗口高度收缩；字节与速度并入文件标题行。触控输入仍使用至少 30 px 行高，较大的系统字体会相应增加行高。

本轮 TypeScript 检查、19 项文件专项和实际宿主的 15 项 Chromium 交互检查通过。80 文件目录在 1600 × 1000 窗口中实测完整显示 36 行，其中 33 个文件；文件树可用高度为 804 px。

[大量文件的紧凑布局截图](../.local/verification/files-compact/files-compact-many-files.png) · [布局测量](../.local/verification/files-compact/density-report.json) · [本轮交互报告](../.local/verification/files-compact/files-ui-report.json)

## Git 标记、忽略灰显和图标（2026-10-22）

文件使用颜色与 `U/A/M/T/R/C/!` 字母，目录汇总后代变动并使用颜色与圆点；忽略的文件和目录灰显，无字母或圆点，仍能操作。标记独立于目录分页加载，沿用原来的有界派生缓存，不新增数据库。桌面继续保持 22 px 行高、12 px 字号、12 px 缩进，触控至少 30 px。

| 验证 | 结果与证据范围 |
| --- | --- |
| TypeScript | `npm --prefix paseo-plugin run typecheck` 通过。 |
| 完整 Node 回归 | 675 项全部通过，包括协议、runtime/cache、handoff-image、Reviewer 和原有文件操作。 |
| 新增专项 | 15 项。使用真实临时 Git 仓库覆盖未跟踪、新增、修改、暂存后再次修改、重命名、删除、类型变化、冲突、同一路径的暂存删除与磁盘文件并存；另有客户端缓存、优先级和图标检查。 |
| 忽略语义 | `.gitignore`、目录、否定规则、本地及全局排除、已跟踪文件命中规则、换行／制表符／路径规格特殊前缀文件名均通过。外部全局排除变化按 30 秒版本核验，手动刷新立即核验。 |
| 仓库与实例 | 多仓库、嵌套仓库、Gitlink 内容与指针的边界、重命名旧新父目录计数、实例替换、移除清理和迟到响应通过。原始 XY 快照在 Git 页与文件树之间复用。 |
| 扫描与失败行为 | 展开已忽略目录不会再扫描状态；真实上传分块和持久日志写入配合受控监听事件注入，确认仓库内部的传输缓存不使 Git 版本失效。统计补齐也不使原始状态失效。刷新失败保留旧标记，首次失败为未知。 |
| 实际 Paseo 宿主 | 使用独立 home、注册表、临时项目和真实插件。`verify-live.mjs` 的 19 项宿主检查通过，正常插件与注册表未被重载。 |
| 实际 Chromium UI | 1600 × 1000 桌面及 1100 × 900 触控模拟通过。验证颜色和字母／圆点、规则来源、灰显项可复制、图标、深浅主题、密集列表、`U → A` 自动更新、选择和滚动保留、Workspace 状态隔离，以及长按说明和后续菜单点击。 |
| 页面和控制台 | 页面身份、非空内容、无框架错误覆盖层和交互检查通过；没有页面异常或控制台错误。宿主记录两类现有 Web 警告：推送 token 监听不支持 Web，以及原生动画驱动在 Web 回退到 JS。 |
| Windows 客户端 | 本轮没有 Windows 实机证据，待验收。Chromium 结果不代替 Windows 客户端结果。 |
| Pocket 真机 | 本轮没有 Pocket 实机证据，待验收。触控模拟验证手势和 30 px 行高，不代替 Android WebView 真机验收。 |

触控复核发现并修复了长按松手误点新菜单项的问题；实际触摸事件回归同时检查“没有误开新建目录对话框”和“下一次菜单点击仍可用”。

复现：

```sh
node --experimental-strip-types --test paseo-plugin/tests/file-decorations.test.ts
node paseo-plugin/scripts/verify-files-git-ui.mjs
```

新增 UI 脚本默认把截图和 JSON 写入临时目录，也可用 `WORKBENCH_VERIFY_OUTPUT` 指定位置。本轮本机产物在 `/tmp/wb-file-git-qa-b6e84d/`：`full-tests-final.log` 是完整回归，`acceptance/` 内是最终 Git UI 截图、JSON 和实际宿主日志。执行时内置 Browser 没有可用实例，沿用独立 Playwright Chromium 验证；所有宿主与项目均隔离。早先原有 15 项文件与传输 UI 交互也重新通过，结果保存在该目录的 `final/`。
