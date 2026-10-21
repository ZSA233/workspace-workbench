# Paseo Pocket

面向 Paseo 的社区 Android 薄壳，包名 `dev.paseo.pocket`，版本由 `version.properties` 统一管理。
与本仓库的 `paseo-plugin/` 独立构建、独立版本；不要求启用 Workbench 插件。
不修改 Paseo 宿主或 relay，未关联官方 App 的签名或发布渠道。

[下载已签名 APK](https://github.com/ZSA233/workspace-workbench/releases?q=android-v&expanded=true) ·
[自动发版与签名配置](../docs/releasing-android.md)

## 使用

打开 App 即进入内置 Paseo 网页。首次在网页里添加主机或粘贴配对链接；之后恢复上次工作页面。
主机切换、改名继续使用网页已有界面。浏览器、官方 App 和本 App 的配对数据独立，需要重新配对一次。

网页占据工作区；贴边的路径标志可拖动、左右吸边并记住位置。
旧系统的边缘返回手势若抢占滑动，可长按标志再拖动。
侧柄可见区域 26×52dp，触控区域至少 48×56dp；点击打开底部四格工具面板。
外观、网页版本、更新来源、缓存与诊断均在同一个面板中切换，子页可返回工具首页。
菜单覆盖在网页上，不会重新加载或创建第二个 WebView。
只有确认应用页面更新或手动恢复才会重开网页。
状态栏、刘海、手势区域与键盘由原生容器统一避让，网页不重复计算这些边距。

“外观”提供跟随系统、明亮、深色。网页通过颜色偏好跟随；在网页内明确选择的主题优先。
返回依次收起键盘、返回面板上一级、关闭面板、返回网页历史，根页面时退出前台。
支持系统文件选择、剪贴板、外部链接。渲染进程退出后显示恢复按钮，不自动重发任务。

最低 Android 8 / API 26；网页要求已更新的系统 WebView（Chromium 100 或以上）。
旧引擎显示升级入口，不留空白页。实际验证的系统和引擎组合见 [验收记录](VERIFICATION-0.1.1.md)。
App 使用 Android 选定的 WebView；“缓存与诊断 → 网页引擎与更新”显示提供方、版本及更新入口。
引擎切换属于系统设置，会影响其他 WebView App，并可能重启本 App。

## 本地网页、缓存与连接

APK 内置完整 Paseo Web `0.12.0`（39 个文件，约 23 MB），来源为锁定的官方 npm 包。
静态页面、脚本、字体、图标和按需模块都在本地，固定来源为
`https://appassets.androidplatform.net`。缺文件显示本地错误，不向官网补脚本。
断网时界面仍可加载；会话、文件、终端等业务需要实时连接主机。

“清理临时资源缓存”清理本 App 共用 WebView HTTP 缓存，保留 Cookie、localStorage、
IndexedDB、主机配对和已安装网页。卸载 App 或在系统里清除 App 数据会删除这些数据。
诊断只保留有限事件代码，不采集会话内容、配对链接、URL 或控制台正文。

推荐沿用已有 relay 配对方式，已在隔离宿主上验证。直接连接主机时，如果宿主限制来源，
需要在它已有的 CORS 配置 `daemon.cors.allowedOrigins` 中加入本地来源；
这是部署配置，不是修改宿主代码。不要覆盖原有来源列表，也不要关闭 TLS 校验。

## 手动页面更新

贴边工具 → 网页版本 → 检查页面更新 → 下载并验证 → 应用更新 → 二次确认。
下载和验证不刷新当前页面，可取消；关闭工具面板后仍可继续下载，重开面板显示实际进度。
应用前先处理未发送内容。更新来源编辑在保存后生效，返回时放弃未保存的修改。
没有后台检查、轮询或常驻服务。

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
