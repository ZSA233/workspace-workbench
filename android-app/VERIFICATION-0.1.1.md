# Paseo Pocket 0.1.1 验收记录

日期：2026-10-21。包名 `dev.paseo.pocket`，versionCode 2，沿用 0.1.0 的持久签名。
内置 Paseo Web 仍为 0.12.0，39 个静态文件没有变更。
本次修改原生 Android 工具与图标，没有修改 Paseo 宿主、Workbench 插件或 relay 部署。

## 交付与设计核对

- 路径 Logo 侧柄替换 PP；可见区域 26×52dp、标志 20dp，触控区域至少 48×56dp。
  侧柄紧贴左右边缘，沿用位置偏好。旧 ROM 仅扩大透明触控区，不把可见部分向内推。
- 面板采用 25dp 顶部圆角、拖动条、路径标志与关闭按钮；双列四格最小高度 106dp，
  格间距 9dp、左右边距 16dp。实际设置、网页版本与来源显示在对应格内。
- 四项设置在同一个面板内切换；主题原位更新，编辑来源返回时放弃修改。
  下载时关闭面板不取消传输，重开显示实际状态，应用更新仍需二次确认。
- 明亮与深色使用约定颜色；系统字体缩放保留。短屏、横屏和大字号时允许滚动。
  启动图标包含自适应、圆形和系统主题版本，路径与选定 SVG 一致。

核心实现提交：`9480687`；实机贴边修正：`b94c78f`。

## 构建与自动化

| 检查 | 结果 |
| --- | --- |
| JVM 测试 | 14 项通过，0 失败 |
| 网页资源 Node 测试 | 5 项通过 |
| Android lint | 0 errors；保留已有中文文案等 warnings |
| Gradle 构建 | 调试 APK、设备测试 APK、持久签名发布 APK 均成功 |
| 资源校验 | 发布 APK 的 39 项网页资源逐文件大小与 SHA-256 一致 |
| 发布包元数据 | minSdk 26、target / compile 37、版本 0.1.1 / 2 |
| 发布签名 | APK v2 校验通过，RSA 3072，CN=Paseo Pocket，与 0.1.0 相同 |
| 插件 TypeScript | `npm --prefix paseo-plugin run typecheck` 通过；插件无代码变更 |

相关日志保存在忽略目录 `artifacts/`：`0.1.1-flush-build.log`、
`0.1.1-flush-test-build.log`、`0.1.1-web-assets-tests.log`、`0.1.1-plugin-typecheck.log`。
JVM 报告和 lint 报告位于 `app/build/`。

## 设备与证据范围

| 环境 | 引擎 | 本次验证 |
| --- | --- | --- |
| Redmi K30 5G，Android 10 / API 29 实机 | Google WebView 148.0.7778.120 | 同签名覆盖安装、主题与来源、引擎入口、20 次菜单开关、横屏；最终贴边位置与两侧标志点击、长按拖动 |
| Android 17 / API 37 模拟器 | Google WebView 145 | 常规设备套件 7 项：5 通过、2 条件跳过；单独布局套件 1 项通过 |
| Android 8 / API 26 模拟器 | 预装 Chromium 58 | 常规套件 7 项：3 通过、4 条件跳过；贴边修正后原生侧柄/四格回归另 1 项通过 |

API 37 常规测试覆盖原生布局、取消拖动、返回层级、来源编辑不误保存，
切主题保留同一个 WebView、DOM 和草稿，网页颜色偏好跟随、渲染进程恢复、
来源配置以及真实官方归档的 HTTPS 下载、取消、签名验证和原子应用。
另外独立运行布局测试，检查真实软键盘、输入框避让、20 次面板开关、横屏和
320dp 宽 / 200% 字体；四格功能可达。该测试必须单独运行，避免配置变更与其他测试的 Activity 生命周期交错。

API 26 的旧引擎不能运行完整 Paseo 网页，因此跳过 3 项现代网页测试及默认关闭的布局测试。
已通过原生工具、旧引擎更新提示和签名包安装流程；不能把这解释为 Android 8 + 新引擎的完整网页验收。
模拟器各自单独运行，未同时占用两台模拟器进行最终验收。

发布包在红米上由 0.1.0 覆盖到 0.1.1，未卸载、清数据或操作真实模型任务。
原先的外观、来源和网页存储保留，最终恢复为“跟随系统”、官方来源、右侧停靠。
发布版未开放 WebView 调试 socket。

实机发现旧 MIUI 忽略系统手势排除且未报告侧向手势边距。最终可见区域右端为
屏幕 x=1080、左端为 x=0，不再留下白色间隙；标志轻点可用，两侧长按标志拖动可用。
快速边缘滑动仍可能被系统返回手势接管，可从内侧透明触控区拖动。
仅透明触控区增加，不缩窄网页、不新增侧栏。

截图与日志保存在忽略目录，未将手机通知或其他私人画面提交到 Git：

- `artifacts/0.1.1-ui/phone-flush-right.png`、`phone-flush-left.png`：最终贴边状态。
- `artifacts/0.1.1-ui/phone-flush-tools-light.png`、`phone-tools-dark.png`：实机深浅面板。
- `artifacts/0.1.1-ui/api37-native/`：竖屏、输入法、横屏、窄屏大字号截图。
- `artifacts/0.1.1-phone-flush-qa.log`、`0.1.1-phone-glyph-long-drag.log`：两侧位置与交互。
- `artifacts/0.1.1-device-api37-final.log`、`0.1.1-layout-api37.log`、
  `0.1.1-device-api26-final.log`、`0.1.1-flush-api26.log`：设备测试结果。

## 更新与宿主边界

更新测试使用本地隔离 HTTPS 镜像，包字节和 npm 签名保持官方原样。
检查了错误元数据地址、无效来源、慢速传输、关闭重开面板与取消，以及下载验证后确认应用。
JVM 测试继续覆盖坏签名、未知密钥、摘要不符、危险归档、空间不足和活动记录中断等边界。
这些故障注入不等同于真实手机断电试验。

本次没有重新运行真实 Paseo 宿主或真实 Codex 模型任务；0.1.0 的隔离真实宿主与协议替身证据
单独保留在 [历史验收记录](VERIFICATION.md)。没有重载用户日常插件或重启日常 Paseo。
没有本次 Chrome 对照或长期温度证据，不用短时菜单测试推断长期性能。

## 复现布局回归

构建、签名及常规设备测试命令见 [README](README.md) 与 [历史记录](VERIFICATION.md)。
只在隔离模拟器上单独运行以下布局测试（会临时修改字号、分辨率及旋转，结束时恢复）：

```sh
adb -s DEVICE shell am instrument -w \
  -e class 'dev.paseo.pocket.FloatingToolDeviceTest#keyboardLandscapeLargeFontAndRepeatedMenus' \
  -e layoutChecks true \
  dev.paseo.pocket.test/androidx.test.runner.AndroidJUnitRunner
```

侧柄专项回归：

```sh
adb -s DEVICE shell am instrument -w \
  -e class 'dev.paseo.pocket.FloatingToolDeviceTest#edgeHandleGridNavigationAndCancelledDrag' \
  dev.paseo.pocket.test/androidx.test.runner.AndroidJUnitRunner
```

设备测试使用调试签名；不能直接覆盖正式签名 App。实机验收使用同签名发布包。

## 安装包

`artifacts/paseo-pocket-0.1.1.apk`，11,972,519 字节。

SHA-256：`2fb33f58d278e2cf85ee5e8bc4e9d46f991c8f1031c2013c2fececa725e9874b`

签名证书 SHA-256：`2da3e1a4bf8a44e0e883c2d6989133c54857544b6caf9a35df5d54d3e01e7d69`

配套 `.apk.sha256` 与 `release-manifest-0.1.1.json` 放在同一忽略目录。
