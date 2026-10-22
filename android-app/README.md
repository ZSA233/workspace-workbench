# Paseo Pocket

面向 Paseo 的社区 Android 薄壳，包名 `dev.paseo.pocket`，版本由 `version.properties` 统一管理。
与本仓库的 `paseo-plugin/` 独立构建、独立版本；不要求启用 Workbench 插件。
不修改 Paseo 宿主或 relay，未关联官方 App 的签名或发布渠道。

[下载已签名 APK](https://github.com/ZSA233/workspace-workbench/releases?q=android-v&expanded=true) ·
[自动发版与签名配置](../docs/releasing-android.md)

[0.1.6 文件上传与保存](../docs/releases/paseo-pocket-0.1.6.md) ·
[0.1.5 升级功能与验收记录](../docs/releases/paseo-pocket-0.1.5.md)

维护时在仓库根目录运行 `make` 查看快捷指令：`make android-check` 检查项目，
`make android-package` 本地打包，`make android-release VERSION=0.1.6` 创建并推送新版本。

## 使用

打开 App 即进入内置 Paseo 网页。首次在网页里添加主机或粘贴配对链接；之后恢复上次工作页面。
主机切换、改名继续使用网页已有界面。浏览器、官方 App 和本 App 的配对数据独立，需要重新配对一次。

网页占据工作区；贴边的路径标志可拖动、左右吸边并记住位置。
旧系统的边缘返回手势若抢占滑动，可长按标志再拖动。
侧柄可见区域 26×52dp，触控区域至少 48×56dp；点击打开底部四格工具面板。
四格固定为：左上外观、右上网页更新、左下应用升级、右下连接与诊断。
网页更新来源在网页更新子页内，保存或返回后先回网页更新页，再回工具首页。
菜单覆盖在网页上，不会重新加载或创建第二个 WebView。
“应用升级”下载并安装 APK；“网页更新”只切换内置网页资源，两者分别展示当前版本与进度。
只有确认切换网页版本或手动恢复才会重开网页；安装 APK 会结束当前应用进程。
状态栏、刘海、手势区域与键盘由原生容器统一避让，网页不重复计算这些边距。

“外观”提供跟随系统、明亮、深色，保存后冷启动也会生效。
网页通过颜色偏好跟随；在网页内明确选择的主题优先。
返回依次收起键盘、返回面板上一级、关闭面板、返回网页历史，根页面时退出前台。
支持系统文件选择、剪贴板、外部链接。渲染进程退出后显示恢复按钮，不自动重发任务。

最低 Android 8 / API 26；网页要求已更新的系统 WebView（Chromium 100 或以上）。
旧引擎显示升级入口，不留空白页。实际验证的系统和引擎组合见 [验收记录](VERIFICATION-0.1.3.md)。
App 使用 Android 选定的 WebView；“连接与诊断 → 网页引擎与更新”显示提供方、版本及更新入口。
引擎切换属于系统设置，会影响其他 WebView App，并可能重启本 App。

## 本地网页、缓存与连接

APK 内置完整 Paseo Web `0.12.0`（39 个文件，约 23 MB），来源为锁定的官方 npm 包。
静态页面、脚本、字体、图标和按需模块都在本地，固定来源为
`https://appassets.androidplatform.net`。缺文件显示本地错误，不向官网补脚本。
断网时界面仍可加载；会话、文件、终端等业务需要实时连接主机。

“清理临时资源缓存”清理本 App 共用 WebView HTTP 缓存，保留 Cookie、localStorage、
IndexedDB、主机配对和已安装网页。卸载 App 或在系统里清除 App 数据会删除这些数据。
诊断只保留有限事件代码和数值，不采集会话内容、配对链接、URL 或控制台正文。

推荐沿用已有 relay 配对方式，已在隔离宿主上验证。直接连接主机时，如果宿主限制来源，
需要在它已有的 CORS 配置 `daemon.cors.allowedOrigins` 中加入本地来源；
这是部署配置，不是修改宿主代码。不要覆盖原有来源列表，也不要关闭 TLS 校验。

## 连接与性能诊断

贴边工具 → 连接与诊断，可查看本地网页加载、主机连接、会话列表同步和就绪状态。
列表就绪不代表当前会话历史、终端或附件也已加载。主机使用本次页面的匿名编号；
未观测到的阶段起点显示为不可用，不把等待首次配对的时间算成连接耗时。
“检查连接”复用 Paseo 已有的验证和重连能力，不刷新网页、不创建替代会话或重发任务。

网页适配脚本随 APK 提供，不修改已验证的网页包，不改页面布局、不替换网络对象。
当前支持 Paseo Web 0.12.0；网页升级后不兼容时，只停用详细状态适配，网页和基础诊断继续运行。
消息只接受固定本地 HTTPS 来源的顶层页面，并检查页面代号、协议、大小和频率。

短暂离开前台保留页面：从 Activity 真正不可见开始，保留 30 秒网页定时器运行机会，
之后暂停；返回时恢复原 WebView 并验证连接。Android 仍可提前休眠或回收进程，
重启后仍需加载本地页面和重新连接。没有保活服务或唤醒锁。

展开“查看性能”时，CPU／UID 收发速率每 2 秒更新，PSS 内存每 5 秒更新。
CPU 和 PSS 属于 App 本进程，不包含整个 WebView；单核 100%，多线程可超过 100%。
流量属于可统计的 App UID，不专属于主机 WebSocket，也不保证覆盖所有隔离进程。
心跳延迟取自已有测量，不增加网络测速；时间表示最近观察时间。
支持时显示网页长任务，不能据此推算整体帧率或电池消耗。
收起性能、关闭面板或离开前台停止采样；网页长任务观察同样按需启停。

“录制 60 秒诊断”可在关闭面板后继续，切到后台立即结束。
日志最多 200 条且不超过 128 KiB，旧版事件记录可继续读取；
`cpu_milli` 的单位为单核百分比的千分之一。报告只经用户复制或分享，不自动上传。

## 手动网页更新

贴边工具 → 网页更新 → 检查网页更新 → 下载网页资源 → 切换网页版本 → 二次确认。
下载和验证不刷新当前页面，可取消；关闭工具面板后仍可继续下载，重开面板显示实际进度。
切换前先处理未发送内容。“网页更新来源”编辑在保存后生效，返回时放弃未保存的修改。
网页更新仅手动触发，没有后台更新检查或常驻服务。

默认从官方 `@getpaseo/server` npm 发布信息检查。自定义来源填写 HTTPS 更新信息地址，
使用 npm 字段 `name`、`version`、`dist.tarball`、`dist.integrity`、`dist.signatures`。
切换来源不会更换当前页面或清除配对。

两种来源使用同样的内置信任公钥、npm ECDSA 签名与完整归档 SHA-512 校验。
镜像只能改变下载地址，包内容、版本、摘要和签名保持官方原样。
未知签名密钥需要更新 APK；不自动下载并信任新密钥。
包名不符、坏签名、摘要不符、危险路径、特殊文件、缺少入口资源、空间不足等都会中止。
归档按流下载和解包，不执行上游安装脚本或服务端程序。

完整包安装到私有持久目录，经校验后原子切换活动记录。保留当前包和上一完整包，
下载、验证或应用准备失败不会替换当前包。进程中断的临时文件在下次启动清理。
首版不提供任意降级；保留上一包不等于可以回滚跨版本网页存储。
签名证明来自被信任的发布体系，不代表上游代码没有漏洞。

镜像生成命令见 [web-assets/README.md](../web-assets/README.md)。无需部署 GitHub Pages，
也无需更改现有 relay；本项目不自动发布任何线上资源。

## Workspace 文件传输

配合 Workbench 插件 0.6.0，「文件」菜单的下载会先打开 Android 系统保存选择器。
确认文件名与位置后才创建任务；取消选择不会传输或留下队列记录。保存使用仅向可信主页面开放的独立桥，按块写入系统选中的文档，关闭成功后才确认完成。

上传继续使用系统文件选择器，不要求手动浏览本地目录后再复制。前台传输可暂停、继续及取消；页面重建后必要时重新选择目标。应用不增加文件传输后台常驻服务。

已安装 0.1.5 的用户需要升级 APK 才能使用原生保存窗口；仅更新网页资源无法添加原生桥。使用「应用升级」检查 0.1.6，Workbench 插件另行更新到 0.6.0。

## Workbench 文件保存

Pocket 0.1.7 可以依次选择多个文件的系统保存位置，同时继续已有文件写入。每个目标独立管理，选择位置不会立即截断文件，真正写入时才打开输出流；取消只作用于对应文件。零字节文件也以成功关闭为完成依据。页面重建会释放未完成的本代目标，需要重新选择保存位置；本版没有新增后台常驻服务。

与 Workbench 0.7.1 配合使用，旧版插件的 `WorkbenchFileSave.open(name)` 入口继续可用。设备验收状态见 [0.7.1 / 0.1.7 验证记录](../docs/verification/ux-performance-0.7.1.md)。

## Pocket 应用升级

从 0.1.5 起，工具面板左下格提供“应用升级”。0.1.4 及更早版本需要先从
[GitHub Releases](https://github.com/ZSA233/workspace-workbench/releases?q=android-v&expanded=true)
手动安装一次新 APK，之后即可使用 App 内更新。

流程：检查应用更新 → 下载 APK → 校验 → 安装 APK → 安装提醒 → 系统授权与安装确认。

- 默认回到前台时每 24 小时最多检查一次，以检查尝试时间计时，可以关闭；不循环重试。
  发现新版本仅更新工具格提示，不弹窗。没有后台定时检查、常驻服务或自动下载。
- 分页读取公开 Release，只接受 `android-vMAJOR.MINOR.PATCH` 的非草稿、非预发布版本，
  并要求完整 APK、`release.json` 和 `SHA256SUMS`。不使用仓库全局 Latest，插件发布不会触发 APK 更新。
- 同时要求版本名与 versionCode 递增；下载采用流式写入，可取消。APK 上限 80 MiB。
- 核对清单摘要、APK 摘要、包名、版本、系统兼容及与当前安装 App 相同的签名证书身份，再交给 Android 安装器最终验证安装。
  已下载且核对过的安装包可在重启后恢复并重新校验；不清除配对、网页存储或已安装网页。
- 关闭面板不取消下载；进程仍存活时可以继续，Activity 销毁时取消。没有下载保活服务或断点续传。
  启动后清理半包，最多保留一个待安装 APK；升级成功后清理旧包。
- APK 与网页更新共用执行互斥，忙碌时另一页显示提示及入口。离线显示上次确认的缓存版本和检查时间，
  不把缓存结果当成本次已检查到最新。拒绝授权或取消系统安装后可继续使用已下载 APK。
- 首次安装时，系统可能要求允许 Pocket“安装未知应用”；返回后继续。每次升级仍由系统确认，
  不进行静默安装。安装前先保存未发送内容，系统替换 APK 会重启 App。
- GitHub 不可达、请求受限或校验失败时继续使用当前版本，可从更新页打开公开发布列表手动下载。
  使用者无需 GitHub 账号或访问 Token。

源码自行构建时，更新仓库依次取 `PASEO_POCKET_UPDATE_REPOSITORY`、Actions 的
`GITHUB_REPOSITORY` 或默认 `ZSA233/workspace-workbench`。升级包的签名身份必须与当前 App 相同；
发布工具同时核对 `signing-certificate.sha256`，自建发行版应配置自己的仓库与对应签名。

## 构建与签名

需要 Node.js 22、JDK 17、Android SDK `platforms;android-37.0` 和 `build-tools;36.0.0`。
AGP 9.4.0、Gradle Wrapper 9.6.0、WebKit 1.17.1、compile/target 37；其他依赖见版本目录。
从仓库根目录执行：

```sh
npm --prefix web-assets ci --ignore-scripts
npm --prefix web-assets test
cd android-app
./gradlew testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest
python3 scripts/verify-apk.py app/build/outputs/apk/debug/app-debug.apk
node scripts/create-signing-key.mjs
./gradlew assembleRelease
python3 scripts/verify-apk.py app/build/outputs/apk/release/app-release.apk
```

首次构建从锁定 npm 归档生成网页，之后使用经验证的构建缓存。生成网页和构建结果不进入 Git。
普通 CI 只生成调试 APK；`android-v*` tag 触发独立的正式发布工作流。
发布构建要求持久签名，缺少配置会失败。

设备故障注入、进程终止和性能对照使用独立测试包，避免影响日常 App：

```sh
cd android-app
./gradlew -PpocketTestPackage=dev.paseo.pocket.qa assembleDebug assembleAndroidTest
adb -s "$POCKET_DEVICE" install -r app/build/outputs/apk/debug/app-debug.apk
adb -s "$POCKET_DEVICE" install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s "$POCKET_DEVICE" shell am instrument -w dev.paseo.pocket.qa.test/androidx.test.runner.AndroidJUnitRunner
```

该参数只改变调试包，正式包始终为 `dev.paseo.pocket`。长字号／横屏布局测试需单独运行，
沿用历史验收记录中的 `layoutChecks=true`。两个 `benchmark-*.mjs` 脚本只操作独立测试包，
并要求其中只登记 `localhost:19444` 的隔离主机；不应对日常 App 注入故障。

APK 更新专项使用 `scripts/serve-app-update-fixture.mjs`（localhost HTTPS 19446）与
`AppUpdateDeviceTest`。准备 `artifacts/github-0.1.4/` 中的公开原始 APK、清单及校验文件，
在专属模拟器内预装公开 0.1.2 主包，再运行 QA 测试；参数为
`-e appUpdateFixture https://localhost:19446`，并配置对应 adb reverse。
测试核对真实签名、下载中断、私有文件分享和系统安装确认，并将专属模拟器内的 0.1.2 覆盖到 0.1.4。
没有 fixture 参数时这些集成项会条件跳过；菜单与 WebView 保留测试独立执行。

密钥默认在 `~/.config/paseo-pocket/`，不会进入仓库。
请安全备份该目录；后续覆盖升级必须使用相同密钥并递增 `versionCode`。
创建脚本遇到已有配置会停止，不覆盖旧密钥。
可用 `PASEO_POCKET_SIGNING_PROPERTIES` 指向私有 properties 文件：

```properties
storeFile=/private/path/release.p12
storePassword=PRIVATE
keyAlias=YOUR_ALIAS
keyPassword=PRIVATE
```

不要提交密钥或密码。调试签名和发布签名不同，无法直接互相覆盖安装；
先卸载调试版本会丢失该调试 App 的数据，不能对正式版本这样处理。

## 验证与维护

见 [实现结构](DESIGN.md)、[0.1.2 发布验收](VERIFICATION-0.1.2.md)、
[0.1.1 界面验收](VERIFICATION-0.1.1.md) 和 [0.1.0 历史记录](VERIFICATION.md)。
设备测试需要 `adb`，只操作本项目 App 和隔离测试主机。
调试构建在构建时生成仅信任 `localhost` 的测试 CA；发布 APK 不含此 CA 或调试配置。
测试辅助脚本不进入 APK。

APK、网页资源工具、Workbench 插件版本分别维护。
更新网页锁定版本时同时审查 `web-assets/upstream.lock.json`、`trust.json`、许可及兼容性；
更新 npm 公钥必须随 APK 发布。第一版无推送、后台常驻或通用脚本 hook。

路径 Logo 源稿在 [route.svg](../docs/design/paseo-pocket-tools/route.svg)，Android 资源使用同一路径。
普通动作图标来自 [Lucide](https://github.com/lucide-icons/lucide)，许可保留于
`app/src/main/res/raw/lucide_license.txt`，也可在 App 的开源许可中查看。
