# Paseo Pocket 0.1.0 验收记录

日期：2026-10-21。APK ID `dev.paseo.pocket`，versionCode 1；内置 Paseo Web 0.12.0。
测试只操作本项目 App、临时仓库和隔离 Paseo home，没有重载日常插件、重启日常宿主或改动 relay 部署。
原有未提交插件改动未并入本次 Android 提交。

## 构建与自动化

| 检查 | 结果 |
| --- | --- |
| Gradle Wrapper 9.6.0 / AGP 9.4.0 / JDK 17 | 调试包、设备测试包、持久签名发布包构建成功 |
| JVM 测试 | 13 项通过 |
| 网页资源 Node 测试 | 5 项通过 |
| Android lint | 0 errors；仍有原生中文文案等 warnings |
| APK 静态资源 | 39 / 39 文件字节、大小与 SHA-256 一致，包含完整 _expo 目录及许可 |
| 发布签名 | RSA 3072，APK v2 验证通过，CN=Paseo Pocket |
| 实机发布包 | 已安装；同签名覆盖安装保留外观设置，未开放 WebView 调试 socket |
| Manifest | minSdk 26，target / compile 37，发布包无调试 CA / 网络测试配置 |
| 插件 TypeScript 检查 | npm --prefix paseo-plugin run typecheck 通过；本次未改插件代码 |

JVM 测试覆盖真实 npm 签名及镜像地址、错误签名和未知公钥、HTTPS 限制、摘要错误、
危险路径、链接、重复项、缺入口资源、解包取消、下载中断、元数据与归档限额、空间不足、
活动记录写入中断、安装文件被改动、原子切换及禁止降级。
写入中断由可控文件状态模拟，不冒充手机断电试验。

## 设备矩阵

| 环境 | 系统 WebView | 验证范围 |
| --- | --- | --- |
| Redmi K30 5G 实机，Android 10 / API 29 | Google 148.0.7778.120 | 完整本地网页、4 项设备测试通过；旧引擎专用测试跳过 |
| Android 15 / API 35 Google APIs 模拟器 | Google 124.0.6367.219 | 4 项设备测试通过；旧引擎专用测试跳过 |
| Android 17 / API 37 Google APIs 模拟器 | Google 145.0.7632.218 | 4 项设备测试通过；旧引擎专用测试跳过 |
| Android 8 / API 26 模拟器 | 预装 Chromium 58 | 原生旧引擎升级提示及 HTTPS 签名更新流程通过；3 项现代网页测试按条件跳过 |

Android 8 的预装 58 引擎不能运行该版本 Paseo 网页。App 明确要求更新到 Chromium 100+，
这个下限是兼容性门槛，不代表逐一认证所有 100+ 版本。尚未在 Android 8 + 新引擎组合上完成完整网页验收。
用户更换设备后，实际连接的是 Android 10 手机，因此本记录不声称完成 Android 16 实机验收。

现代设备测试验证：反复打开工具及切换主题仍为同一 WebView，DOM 与草稿保留，
网页颜色偏好跟随，前后台恢复，固定本地安全来源与 IndexedDB，
渲染进程主动退出后仅由用户按钮重开，配对来源的本地存储保留，
自定义来源、真实官方包下载、取消、签名 / 摘要验证、安装、待应用确认和原子切换。
更新包由本地 HTTPS 镜像提供，保留原 npm 签名和归档字节，使用临时 localhost 测试 CA。

额外在 Android 10 实机及 Android 17 模拟器验证了横屏切换、引擎信息入口，
确认不新增 WebView、不丢测试草稿，也不重新引入 CSS 安全区留白。
在 Android 17 模拟器上，已验证的待应用更新经过真实 force-stop / 重新启动后恢复，
活动版本记录保持不变，仍需用户确认应用。

## 实机与真实宿主证据

真实 Paseo 0.12.0 在独立 home 与临时 Git 仓库内运行，关闭插件与 MCP 注入。
Codex 为可控协议替身，产生约 3 万字符长记录，不执行真实模型任务。
通过现有 relay 完成两台隔离主机的网页配对；不会修改日常宿主的状态或任务。
配对、主机名称修改及导航使用原网页控件，无主机名替换脚本。

实机检查包括：进入长会话、阅读及滚动、本地网页断网加载、缺失静态资源返回本地 404、
手动恢复、真实输入框草稿、键盘弹出 / 收起、清理临时缓存不重载或丢草稿，
从 Android 系统文件选择器选择测试 TXT 附件后返回会话，草稿仍保留且未发送任务。

修复了实机发现的两项关键问题：

- AAPT 默认忽略下划线目录，导致 _expo 脚本未打入 APK。已调整资源规则并增加逐文件 APK 校验。
- Android 10 的 DisplayCutout 经新 WebView 再次变为 CSS safe-area，造成顶部额外约 35dp。
  已将原生处理过的边距及 cutout 清零；实机 env(safe-area-inset-top) 从 35px 变为 0px，
  菜单按钮在网页内的位置从 y=55px 恢复到 y=20px，系统状态栏仍保留。键盘收起后不残留空白。

直接连接另有宿主 CORS 来源限制；通过其已有 allowedOrigins 配置验证本地来源可连接。
relay 配对不需要改动用户正常宿主配置。

## 性能证据与边界

隔离长记录的短时程序滚动采样为 240 帧 / 约 2.035 秒，最长帧间隔 33.4ms。
这只说明该次短采样情况，不能据此判断长期温度、真实大型会话的性能或原 App 崩溃根因。
App 没有后台更新轮询或常驻服务，退到后台暂停 WebView 定时器。
按用户后续意见跳过 Chrome 安装和浏览器 A/B 对照，不声称完成该性能对照。
真实 Codex 模型执行、长期热负载及用户日常全部插件组合不在本次隔离证据内。

## 复现

从仓库根目录构建，命令见 [README](README.md)。设备测试可使用以下隔离镜像：

```sh
node web-assets/src/mirror.mjs --version 0.12.0 --output web-assets/output/device-mirror \
  --public-base https://localhost:19443/
node android-app/scripts/serve-device-mirror.mjs
```

另一个终端（替换 DEVICE）：

```sh
adb -s DEVICE reverse tcp:19443 tcp:19443
adb -s DEVICE install -r android-app/app/build/outputs/apk/debug/app-debug.apk
adb -s DEVICE install -r android-app/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s DEVICE shell am instrument -w -e mirrorUrl https://localhost:19443/latest.json \
  dev.paseo.pocket.test/androidx.test.runner.AndroidJUnitRunner
node android-app/scripts/verify-device-web.mjs DEVICE
```

`serve-isolated-paseo.mjs` 创建独立宿主、测试代理和协议替身。
可通过 PASEO_CLI 指定已安装 CLI；可选的 POCKET_TEST_RELAY_CONFIG 只读取配置中的 relay 字段，
不会加载那份配置的 home 或改动它。POCKET_TEST_PROXY_PORT 可给第二台测试主机分配不同本地端口。
配对材料、设备日志、测试证书、截图及 APK 在忽略目录内，不进入 Git。

测试结束应关闭本次启动的代理、隔离宿主和模拟器，移除相应 adb reverse；
先确认进程、端口和 AVD 名称归属，不使用日常 daemon stop 或 plugin reload 命令。
