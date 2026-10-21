# Paseo Pocket 0.1.5

版本：0.1.5 / versionCode 6；包名：`dev.paseo.pocket`。验收日期：2026-10-22。

## 使用变化

- 四格依次为外观、网页更新、应用升级、连接与诊断；网页更新来源位于网页更新子页。
- 应用升级从 GitHub 的 `android-v*` 正式 Release 检查 APK，默认每 24 小时在前台检查一次。
  只提示新版本，不弹窗、不自动下载、不增加常驻服务。插件和预发布版本不会被选中。
- 下载 APK 后校验大小、摘要、包名、版本、系统要求及签名身份，由 Android 最终确认安装。
  完整安装包重启后可恢复，取消授权或安装后可重试；离线显示带检查时间的缓存信息。
- 网页更新继续手动检查、下载、验证、确认切换，两套更新互斥。面板操作保留原 WebView 和草稿。
- 修正深色面板切换子页时，Material 使用旧主题覆盖状态栏图标颜色的问题。

0.1.4 及更早版本需要先手动安装一次本版，之后才能使用 App 内应用升级入口。

## 本地构建与检查

| 检查 | 结果 |
| --- | --- |
| `make android-check` | 30 项发版／观察脚本测试、5 项网页资源工具测试、39 项 JVM 测试全部通过，lint 通过 |
| 调试、AndroidTest、持久签名发布构建 | 通过；状态栏修正后重新构建并检查 lint |
| APK 静态资源检查 | 39 个完整 Paseo Web 0.12.0 资源通过 |
| APK 签名校验 | 与 0.1.4 持久签名一致 |

签名证书 SHA-256：

```text
2da3e1a4bf8a44e0e883c2d6989133c54857544b6caf9a35df5d54d3e01e7d69
```

## 隔离模拟器与协议替身

| 环境 | 验证结果 |
| --- | --- |
| Android 17 / API 37 | 7 项不同用例通过：四格／子页与 WebView／草稿保留、每日检查与离线恢复、签名下载与安装、坏摘要与取消／互斥、网页更新全流程、侧柄与返回、横屏／大字号／反复开关 |
| Android 8 / API 26 | 3 项原生升级用例和 1 项旧引擎提示用例通过；系统 WebView 58，不执行要求 Chromium 100 的现代网页界面用例 |
| 两个系统的实际安装器 | 真实签名 0.1.4 覆盖到本地签名 0.1.5，安装授权拒绝、取消安装后重试均通过，UID 与私有数据标记保留 |
| 网页更新 | HTTPS 镜像检查、错误来源、取消慢速下载、完整验证及二次确认切换通过；只在确认切换后更换 WebView，本地存储保留 |

APK 元数据与传输故障由 `serve-app-update-fixture.mjs` 的 localhost HTTPS 替身提供；
安装包是持久密钥签名的真实 APK，安装确认由真实 Android 系统完成。网页镜像保留官方 npm 包、摘要与签名。
安装授权状态由测试 app-op 控制，验证设置 Intent、拒绝返回及重试；没有把测试回调当作实际系统设置页操作。
这些证据不代表真实 GitHub 网络上的手机端端到端更新，也不代表真实 Paseo 主机任务或模型测试。
本轮没有连接实机；没有卸载、清理或操作用户的手机数据。

设备测试在独立 QA 包及本仓库拥有的模拟器中执行。撤销安装权限会被 Android 用来主动终止 UID，
因此测试结束后才从外部清理权限。Android 8 的数据标记在 App 自己创建私有目录后写入，避免 root 抢先创建目录。
取消下载用例关闭 UiAutomator 的隐式空闲等待，避免进度更新使点击延迟到下载结束。

本地日志及截图在忽略的 `android-app/artifacts/app-update-0.1.5-*` 中，包括深浅主题、
网页／APK 子页、320dp 大字号、横屏和键盘截图。

## 提交与发布

- `769f3a8`：GitHub APK 策略、持久化、签名身份校验、系统安装入口与更新互斥。
- `341545f`：四格与页面层级、独立文案、界面回归和状态栏修正。
- `66c17c2`：版本与使用／验收文档。
- `1f358c9`：移出另一项未完成的文件保存接线，通过干净构建；本地草稿原样保留。
- 正式 tag：`android-v0.1.5`；版本与使用文档单独提交。
- [Release](https://github.com/ZSA233/workspace-workbench/releases/tag/android-v0.1.5)
- [签名 APK](https://github.com/ZSA233/workspace-workbench/releases/download/android-v0.1.5/paseo-pocket-0.1.5.apk)
- [公开产物校验摘要](https://github.com/ZSA233/workspace-workbench/releases/download/android-v0.1.5/SHA256SUMS)

## 公开发布复核

- [Android CI](https://github.com/ZSA233/workspace-workbench/actions/runs/39667854671) 与仓库 CI 通过。
- [正式发布 Actions](https://github.com/ZSA233/workspace-workbench/actions/runs/39668555894) 成功；Release 已公开，为正式版。
- 从公开 HTTPS 地址无认证重新下载 APK、`release.json` 和 `SHA256SUMS`，两个文件摘要均匹配。
- APK 为 `dev.paseo.pocket` / 0.1.5 / code 6，min API 26、target API 37，证书与 0.1.4 相同。
- 39 个内置网页资源完整。APK 仅包含本次升级功能，文件保存草稿保留在本地工作区。
- 发布清单的源码提交与自动化提交均为 `1f358c9304f26707f46a7e72b2fb2d30256bddce`。
- 仓库全局 Latest 仍为插件 `v0.5.1`；Pocket 使用独立的 `android-v*` 发布系列。

公开 APK：12,029,459 字节；SHA-256：

```text
f12efe0a14d629f3da3942a3e2819d248e02a91a9036e0a2014be6aed66cb85a
```
