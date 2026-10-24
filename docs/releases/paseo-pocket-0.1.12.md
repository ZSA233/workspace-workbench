# Paseo Pocket 0.1.12 与 Workbench 0.7.9

Pocket 0.1.12 / versionCode 13；内置 Paseo Web 0.13.0。沿用 dev.paseo.pocket 包名和原持久签名。

右侧侧栏改用 Paseo 官方 Tab 和“＋”菜单。Workbench 通过官方 Explorer 面板 API 接入，删除旧侧栏注入、内部模块挂接、React Portal、专用原生桥和 Pocket SDK。文件保存、选图、连接诊断为独立能力并保留，选图和诊断适配已验证的 0.12.0、0.13.0。

已有配对、网页存储和当前网页选择保留；仍在 0.12 的用户可从网页更新手动升级。0.12 不再提供旧注入的侧栏 Tab，插件原菜单入口保留。已经安装的新网页不会降级。

## 验证

- 普通 Chromium 与实际隔离 Paseo 0.13 宿主：官方“＋”打开 Workbench 和独立示例插件，使用实际 RPC；Files 切换、文件打开与返回、提交比较及 Diff、重载恢复、深浅主题与宽窄布局均通过。
- Android API 37 模拟器与独立 QA APK：原生触摸取得 WebView 焦点后读取实际仓库提交，官方 Tab 切换、进程重启后的配对／会话／标签恢复、横屏和深色均通过；没有 window.Pocket 或旧侧栏注入。
- 原生 PhotoPicker：先取消再选两张图片，实际 IndexedDB 与协议替身接收到的图片逐张核对 SHA-256，无额外处理悬浮提示。脚本等待真实持久化完成后校验，通过实际 Send 按钮处理函数发送，避免 IME 坐标时序干扰。
- 原生设备回归 5 项通过：系统文件保存、取消与并行选择、工具／主题／横屏／后台保留单 WebView 和未发送状态、实际诊断桥与性能采样。测试修正了跨窗口滚动定位；只重跑失败的菜单用例。
- Pocket Node 62、网页资源测试 5、插件入口回归 20、Android JVM 43 项通过；插件 typecheck、lint、调试／正式签名构建及 40 项 APK 网页资源核验通过。

实际模型调用未测试；没有连接真机。本次未修改 Paseo 宿主、relay 或正常插件运行状态，失败注入和测试数据仅存在于隔离 QA 环境。

[结果记录](../verification/pocket-sidebar-0.1.12/summary.json) · [普通浏览器](../verification/pocket-sidebar-0.1.12/browser-workbench.png) · [Android](../verification/pocket-sidebar-0.1.12/android-workbench.png) · [深色](../verification/pocket-sidebar-0.1.12/android-dark.png)
