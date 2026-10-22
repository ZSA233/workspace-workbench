# 0.7.1 / Pocket 0.1.7 体验与性能验收

基线为 `e51ee67`（插件 0.7.0，Pocket 0.1.6）。本次仅优化调度、解析、传输、保存与目录排序，保留文件树密度、缓存先显示、先选择保存位置的流程，不增加文件大小或数量上限。

## 性能对照

macOS arm64、Node 22.22.1；同一份数据，前后版本交错测量各 20 次。下载阶段为真实客户端传输实现，RPC 注入固定往返延迟，持久暂存使用零延迟的连续偏移测试替身；这组结果不能代替公网吞吐或 Windows 实机测试。实际宿主另行验证了真实 OPFS 写入与最终关闭。

| 指标 | 0.7.0 | 0.7.1 |
| --- | ---: | ---: |
| 8 MiB 下载，100 ms RTT，中位数 | 3,623 ms | 1,123 ms（减少 69.0%） |
| 8 MiB 下载，200 ms RTT，中位数 | 6,790 ms | 2,005 ms（减少 70.5%） |
| 下载数据／确认请求数 | 32 | 17 |
| 650 个目录条目的 ZIP 日志写入，中位数 | 654 | 8（减少约 81 倍） |
| ZIP 日志写入 P95，补齐 250 ms 定时刷新后 | 654 | 9 |
| 首批目录响应 P95，最后一轮 | 14.17 ms | 13.62 ms |

新下载实现每文件最多两个数据请求、两文件合计最多四个。测试核对乱序返回后仍顺序消费、持久暂存前不确认、确认响应丢失时沿用任务 ID、暂停后不接收迟到块、最后保存成功关闭后才完成。旧后端逐块读／确认仍保留。

实际 Paseo 0.12 宿主和 Chromium 使用两套独立 home、项目注册表、相同的 1,200 文件目录，再交错测量各 20 次：

| 界面指标 P95 | 0.7.0 | 0.7.1 |
| --- | ---: | ---: |
| 缓存文件页返回首屏 | 68.1 ms | 66.7 ms |
| 选择文件到两帧后的界面 | 64.6 ms | 68.6 ms |
| 12 帧滚动测试段 | 426.6 ms | 446.9 ms |
| 滚动长任务（大于 50 ms） | 0 | 0 |
| 隐藏闲置面板 11 秒内的文件周期请求 | 10 | 0 |

没有出现同时超过 10% 和 20 ms 的交互退步。滚动段包含帧等待，并非单次事件的处理耗时。浏览器末尾的近似堆读数均为 139 MB，未将这一读数当作精确峰值。下载窗口测试检查数据请求上限，实际大文件回归另行采样 Node RSS。

## 实现与确定性验证

- 128、129、500 个待预热仓库均能结束本轮；增删清单、选中仓库切换、选项和 Workspace 实例变化分别处理，隐藏停止预热，失败不堵住后续仓库。
- 8 个相同源码请求只创建 1 个解析任务；取消一个订阅不取消其余订阅。首次视口立即读取，滚动期间只继续最新视口。
- 相同目录内容复用条目数组；相同 Git 装饰不发送树更新。颜色、选择不重建目录行。普通传输进度 200 ms 合并，暂停等状态立即通知。
- 目录优先和名称排序覆盖所有页，包括索引超预算后的排序窗口；旧游标保留原顺序。滚动、选择、菜单与手势期间延迟应用新顺序，迟到排序不能移动正在操作的条目。
- ZIP 准备进度按 250 ms 或 128 项合并，只更新当前任务的进度字段；暂停、取消、提交和上传确认立即持久化。验证了没有新条目时仍按时刷新，以及暂停不会被迟到进度恢复。
- Pocket 的保存会话分别管理 URI、偏移和输出流。JVM／脚本覆盖延迟打开、交错写入、取消其中一个、零字节成功关闭、关闭失败、页面代次清理与旧桥顺序等待。

## 回归和平台证据

| 检查 | 结果 |
| --- | --- |
| 插件 typecheck、完整 Node 回归 | 待最终发布树复核 |
| Android 发布脚本 | 34 项通过 |
| 网页资源测试 | 5 项通过 |
| Pocket JVM | 43 项通过 |
| Pocket lint、正式 0.1.7 / code 8 APK 构建 | 通过 |
| 隔离实际 Paseo：文件查看、保存、返回、多文件滚动、390 px 窄屏 | 11 项通过，无页面错误或框架错误覆盖层 |
| 隔离实际 Paseo：忽略灰显、Git 颜色、22 px 行高、长按菜单、空间切换 | 7 项通过，无页面错误或框架错误覆盖层 |
| 隔离实际 Paseo：连续 Diff | 通过（统一／左右 Diff、上下文、主题、滚动恢复与窄屏，宿主退出码 0） |
| Android QA APK 和测试 APK | 构建通过；模拟器启动崩溃，未执行设备测试 |
| Windows 实际客户端 | 待验收 |
| Pocket 物理设备、原生系统保存多目标和进程重建 | 待验收 |

实际宿主检查发现从查看页返回新建 Workbench 面板时，设置恢复可能覆盖目标空间；返回操作现等待偏好恢复完成，复测通过。自动化测试始终使用隔离 Paseo home 和项目注册表。Browser 运行时返回 `No browser is available` 且浏览器列表为空，因此按本仓库流程使用 Playwright Chromium；没有借用正常宿主做测试。

Android API 37 独立模拟器保持 adb offline 后以 139 退出，日志包含 `mprotect failed: Permission denied` 及 QEMU 线程无响应。未在用户的正式 Pocket 上安装或清理数据。JVM／脚本结果不能代替系统文件选择器的设备验收。

真实文件服务完整上传、下载、归档 `4,294,967,333` 字节文件，逐块校验及全文件 SHA-256 相同；归档 `4,294,967,703` 字节，Python zipfile 验证 ZIP64 与 CRC 成功。在 192 MiB Node 堆设置下，RSS 从约 111.4 MiB 到 179.1 MiB，增长约 67.7 MiB，没有随 4 GiB 内容线性增长。此项为 Node 服务与文件系统证据，不是客户端大文件峰值。

## 重现

```sh
npm --prefix paseo-plugin run typecheck
npm --prefix paseo-plugin test
node --expose-gc --experimental-strip-types paseo-plugin/scripts/verify-ux-performance.mjs /path/to/v0.7.0/paseo-plugin
node --expose-gc --experimental-strip-types paseo-plugin/scripts/verify-ux-performance.mjs /path/to/v0.7.0/paseo-plugin --zip-only
WORKBENCH_VERIFY_OUTPUT=/tmp/wb-large node --experimental-strip-types --max-old-space-size=192 paseo-plugin/scripts/verify-files-large.mjs
node paseo-plugin/scripts/verify-files-git-ui.mjs
node --experimental-strip-types paseo-plugin/scripts/verify-continuous-diff-ui.mjs
node --test android-app/scripts/test/*.test.mjs
npm --prefix web-assets test
cd android-app
./gradlew --no-daemon testDebugUnitTest lintDebug assembleRelease
```

20 次交错浏览器测量和文件查看的专项脚本及截图保存在本机 `/tmp/wb-ux-browser-perf-v2`、`/tmp/wb-ux-document-ui-v2`；下载和 ZIP 原始测量在 `/tmp/wb-ux-performance.json`、`/tmp/wb-ux-zip-performance.json`。临时目录不进入发布附件。
