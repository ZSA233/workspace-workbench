# Paseo Pocket 0.1.3 验收记录

验收日期：2026-10-21 至 2026-10-22。版本 `0.1.3 / versionCode 4`，包名保持
`dev.paseo.pocket`。本次没有创建 `android-v0.1.3` tag 或发布 GitHub Release。

## 实现与提交

- `5a50025`：受限网页适配、连接状态、阶段计时、按需性能查看和有界诊断。
- `d17b958`：30 秒后台运行机会、回前台验证、生命周期回归与独立测试包，版本递增。
- `fc7343d`：准确的诊断降级文案，以及对 Android AtomicFile 短暂重命名的测试读取重试。
- `bf0bccf`：在 Activity 绑定上下文前恢复外观，修复深色设置在冷启动时未传给 WebView。

签名 APK 的源码提交为 `bf0bccfde25d19d50942798b7a4637a957878578`。
网页仍为官方 Paseo Web 0.12.0，39 个文件；新脚本属于 APK，不改网页归档或文件摘要。
未修改 Paseo 宿主、插件或线上 relay；没有重载用户日常插件或重启日常 Paseo。

## 自动化与设备

| 检查 | 结果 |
| --- | --- |
| Android 脚本测试 | 30 项通过，含发版脚本和 15 项观察适配测试 |
| 网页资源工具测试 | 5 项通过 |
| Android JVM 测试 | 29 项通过 |
| 构建与静态检查 | `make android-check`、debug / release / AndroidTest 构建、debug / release lint 通过 |
| 插件 TypeScript | `npm --prefix paseo-plugin run typecheck` 通过；没有插件源码改动 |
| API 37 / Android 17 模拟器 | 常规 10 项：8 通过，2 条件跳过；布局专项另 1 项通过 |
| API 26 / Android 8 模拟器 | 常规 10 项：3 通过，7 条件跳过 |
| Redmi K30 5G / Android 10 实机 | 独立测试包 3 项通过；冷启动外观专项另 1 项通过；正式签名包覆盖安装及原生界面验收通过 |

API 37 的条件跳过是单独运行的布局专项和只针对旧引擎的升级提示。
实际执行了完整网页、连接适配、性能采样、录制中断、32 秒后台休眠、文件选择器停留超过
30 秒后取消、同一个 WebView / 草稿保留、主题与返回、渲染进程手动恢复、来源错误、
下载取消、官方签名包下载验证及确认后应用更新。

布局专项独立运行，覆盖键盘、横屏、窄屏、200% 字体、拖动取消及反复打开面板。
API 26 预装旧 WebView 58，不能执行完整 Paseo 页面：通过原生侧柄 / 工具、引擎升级提示、
以及通过本地 HTTPS 下载原始官方包并验证安装；现代网页和条件专项如实跳过。
这不代表已验证 Android 8 配合新版 WebView 的完整网页功能。

Redmi 使用 Google WebView 148.0.7778.120。设备故障注入只操作
`dev.paseo.pocket.qa`，测试包及数据与日常 App 独立。正式包从 0.1.1 / code 2
覆盖到 0.1.3 / code 4，签名相同，应用 UID 10276 保持不变，未卸载或清除正式 App 数据。
验证了正式包的诊断页、性能展开、明亮 / 深色切换，并恢复原来的“跟随系统”。
正式 App 当时尚未添加主机；真实主机配对和模型任务不在这次正式包实机证据中。
主机连接、存储及草稿保留使用独立测试包验证。

收到深色冷启动反馈后，在同一 Redmi 的独立测试包复现：已保存 `dark`，冷启动网页仍报告
`prefers-color-scheme: dark = false`。修复将模式恢复从 onCreate 提前到 attachBaseContext，
确保 AppCompat 和第一个 WebView 使用同一初始主题。新增长期保留的冷启动回归，
在已保存深色的全新测试进程中通过，未重新选择外观。
最后这次修改只补跑相关实机专项、debug / AndroidTest / release 构建和 lint，
没有重复此前的全部模拟器和性能实验；最终 APK 包含此修复。

API 37 另做了锁屏、断开模拟电源并强制进入 deep idle 的 35 秒测试。
退出 idle、恢复电源并唤醒后，进程、文档标记和 localStorage 均保留。
这是模拟器受控 Doze 证据，不等同于手机长时间待机或真实耗电测量。

本机旧 avdmanager 把 API 37 AVD 的 target 写成 `android-0`，曾导致软件模拟和启动失败。
仅修正本次专属测试 AVD 为 `android-37` 并扩充数据分区后完成上述验收；没有修改 App 或宿主来绕过。

## 连接耗时对照

同一 Redmi、相同 Paseo Web 0.12.0、相同隔离宿主，使用 localhost TLS 和 adb reverse。
宿主为实际 Paseo CLI 0.12.0，采用隔离 Paseo home、临时 Git 仓库和可控 Codex 协议替身。
没有调用真实 Codex 模型，没有对用户正常会话发送测试任务，也没有经过用户线上 relay。

基线为 `5a50025` 的中间构建：已经有诊断和回前台验证，仍立即暂停定时器。
它不是公开的 0.1.2 APK。这组数据主要比较立即暂停与 30 秒运行机会，不能视为旧正式版到
新正式版的总体性能结论。两侧分别执行 8 次冷启动和 8 次短暂切出再返回；P95 用样本最近秩计算。

| 指标 | 基线中位数 / P95 | 新版中位数 / P95 |
| --- | --- | --- |
| 冷启动：页面开始加载至会话列表就绪 | 2930 / 2989 ms | 2920 / 2980 ms |
| 本地网页加载 | 1134 / 1158 ms | 1138 / 1158 ms |
| 已观测到的连接阶段 | 185 / 204 ms | 180 / 208 ms |
| 短暂切回：恢复开始至就绪 | 106 / 142 ms | 107 / 108 ms |

独立的列表同步阶段没有被这组快速连接样本捕获，报告保留为不可用，没有填成 0。
后台停留按 Home 后约 3 秒控制；新版从 onStop 开始计时，因此实际记录约 2.6 秒，
基线从 onPause 开始记录约 3.2 秒，不能把这一差异当成连接提速。

没有观察到可判定的连接速度改善，也未复现用户描述的 7～8 秒线上等待。
本地结果不能证明 relay、原始旧版或特定长记录是否存在瓶颈。
当前版本已具备阶段和生命周期记录，后续可在真实故障后复制报告继续定位。
没有完成手机连接真实 relay 时的物理断网及 Wi-Fi / 蜂窝切换对照，不能据此判断这些路径的恢复耗时。

## 页面兜底

APK 内含完整官方网页；冷启动静态资源来自固定本地 HTTPS 来源，不依赖官网或更新源在线。
更新失败继续使用已安装版本，详细连接适配不可用时保留基础诊断和网页运行。
这不等同于主机离线时仍能操作远程会话，也不承诺任意新版网页存储可安全回滚到旧版。

## 诊断自身的开销

在独立测试包、同一个已连接页面及同一个原生面板中，以收起、展开、再次收起性能区域的
顺序各采集 30 秒。下表为单核 100% 口径；原生进程由进程 CPU 时钟取差，
渲染进程来自 CDP `Performance.ProcessTime`。

| 状态 | App 本进程 CPU | 渲染进程 CPU | 新增 WebSocket |
| --- | --- | --- | --- |
| 收起性能 | 0.40% | 0.37% | 0 |
| 展开性能 | 3.89% | 0.50% | 0 |
| 再次收起 | 0.27% | 0.37% | 0 |

性能页有可测开销，不能描述为零成本；默认不展开，收起或离开前台即停止采样。
短时渲染器 JS 堆约 70.2～70.6 MiB，未出现连续增长，但不足以排除长期泄漏。
这些数字不涵盖整个浏览器 / GPU，也不能推算手机耗电或温度。
没有做拔掉 USB 后的长期电量、温度或多小时稳定性实验。

## 安装包与证据

`artifacts/paseo-pocket-0.1.3.apk`，12,004,175 字节。

APK SHA-256：

```text
30e6e490437746226e1c046b3adb4a642c96b28f83166f46743ef5219e0b8b2b
```

签名证书 SHA-256，沿用旧版：

```text
2da3e1a4bf8a44e0e883c2d6989133c54857544b6caf9a35df5d54d3e01e7d69
```

配套 `artifacts/paseo-pocket-0.1.3.apk.sha256`、`artifacts/release/release.json`
和 `artifacts/release/SHA256SUMS` 已生成。APK 的包名、版本、签名以及全部 39 个网页资源复核通过。
manifest 中的 tag 字段为预留发版名称，不代表已创建 tag 或已发布。

截图与原始日志仅存放在忽略目录，没有把手机画面提交到 Git：

- `0.1.3-phone-signed-performance-light.png`、`0.1.3-phone-signed-diagnostics-dark.png`：正式包实机界面。
- `0.1.3-phone-signed-smoke.json`、`0.1.3-phone-observation.log`：签名包和独立实机测试。
- `0.1.3-cold-theme-before.json`、`0.1.3-phone-cold-theme-final.log`：深色冷启动复现及修复专项。
- `0.1.3-api37-device-final.log`、`0.1.3-api37-layout-final.log`、`0.1.3-api37-doze.json`：目标系统证据。
- `0.1.3-api26-device-final.log`：最低系统及旧引擎的覆盖 / 跳过结果。
- `0.1.3-recovery-before.json`、`0.1.3-recovery-after-final.json`：连接对照样本。
- `0.1.3-observation-overhead-final.json`：按需采样开销。
- `0.1.3-final-check.log`、`0.1.3-release-build-final.log`、`0.1.3-scripts-tests-final.log`：构建和自动化结果。

Node VM 的替身测试、真实宿主搭配协议替身、真实 Android 系统与正式签名包验收是不同层次的证据。
本记录不把它们等同于真实 Codex 模型测试或用户线上 relay 的故障复现。
