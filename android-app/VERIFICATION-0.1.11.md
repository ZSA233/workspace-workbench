# Pocket 0.1.11 / Workbench 0.7.8

Pocket 客户端扩展接口 v1 已接入真实 Paseo Web 0.12.0。右侧栏保留文件和变更页，追加由已安装插件声明的 Tab。Workbench 首次选中才挂载，复用安装实例的 React、RPC、查询缓存、主题及上下文。SDK 不包含 React、网页选择器或原生模块，不增加安装体系或设备权限。

[SDK 与接入示例](https://github.com/ZSA233/workspace-workbench/tree/android-v0.1.11/paseo-plugin/client/pocket-sdk) · [适配维护](EXTENSIONS.md) · [结果与源码哈希](../docs/verification/pocket-extensions-0.1.11/summary.json)

## 实际验证

Android API 37 arm64 模拟器、系统 WebView 145.0.7632.218，安装独立 `dev.paseo.pocket.qa` APK；本地 HTTPS 原始网页资源连接隔离 Paseo home、项目注册表和临时 Git 仓库。实际验证右侧 Tab 挂载、真实 RPC、正确会话归属、首次加载、原文件栏、系统返回键、收起重开和后台后进程重启恢复。深浅主题使用实际主题 Provider；横屏通过 Android `wm` 旋转，截图取系统合成画面。WebView 的 CDP 截图在此版本会错误压缩部分滚动层文字，未据此修改布局。

[实际工作台](../docs/verification/pocket-extensions-0.1.11/android-workbench.png) · [深色](../docs/verification/pocket-extensions-0.1.11/android-dark.png) · [实际横屏](../docs/verification/pocket-extensions-0.1.11/android-landscape.png)

实际隔离 Paseo 的浏览器验证另一个独立插件，通过公开 SDK 注册八个面板。均调用自己的 RPC、取得有效 Agent 上下文，使用同一安装实例查询缓存。九个扩展 Tab、长标题、固定关闭按钮、标题更新、两个 Workspace 分别记忆、迟到注册、文档重载、插件实际重载和移除通过。文件及固定比较使用已有文件／Diff 查看页；打开后收起侧栏，“返回文件”重新打开原侧栏。资源指纹不兼容时，实际原文件栏仍可操作。

[独立插件与横向 Tab 栏](../docs/verification/pocket-extensions-0.1.11/browser-independent-plugin.png)

未打开 Workbench 的四秒观察窗口内，业务 RPC 为零。打开文件页后切到原文件栏，等待一秒，在随后六秒内业务查询为零，返回保留目录展开。连续切换两个已加载示例面板 60 次，保留两个实例，初始八次示例 RPC 没有增加；DOM 节点保持 1,994，回收后堆约 93 MB，没有持续增长。

模拟器另行通过文件保存、独立多目标写入、取消、零字节及文件选择结果解析共九项 instrumentation 测试。会话输入框从实际系统 PhotoPicker 取消再重选两张 PNG，缩略图、IndexedDB 和实际发送到协议测试 Codex 的字节哈希均一致；连续观察没有添加图片或失败提示遮挡。此流程未替换图片选择、文件内容或发送处理。

[实际输入框缩略图](../docs/verification/pocket-extensions-0.1.11/composer-images.png)

## 性能

同一模拟器分别安装上一版 0.1.10 和当前 0.1.11 的独立 QA 包，连接相同的隔离宿主、相同长会话和原始网页。每版 20 个样本交错执行。首次真实触摸取得 WebView 焦点后，以公共按钮处理函数、稳定动画帧和真实会话滚动容器测量交互；冷启动使用原生日志中的页面及主机就绪时间。

| P95 | 0.1.10 | 0.1.11 |
|---|---:|---:|
| 页面加载 | 550 ms | 537 ms |
| 主机就绪 | 1,832 ms | 1,592 ms |
| 打开原侧栏 | 331.3 ms | 316.7 ms |
| 原文件页切换 | 51.8 ms | 49.3 ms |
| 固定会话滚动序列 | 417.8 ms | 417.9 ms |

滚动序列两版均未记录长任务。未打开 Workbench 时 JS 堆中位数为 100.35／101.70 MB，P95 为 104.67／103.28 MB；DOM 中位数增加 13 个节点。首次打开 Workbench 并取得真实图数据的中位数 380.3 ms，P95 483.3 ms。没有同时超过 10% 和 20 ms 的交互退步；这些结果用于判断本轮开销，不能外推为所有设备的性能提升。

[完整 40 个样本与测量方法](../docs/verification/pocket-extensions-0.1.11/performance.json)

## 回归与边界

插件 typecheck、749 项 Node 回归及实际 Hermes 加载通过。Pocket 72 项 Node、54 项绑定官方网页的适配测试、5 项网页资源测试、43 项 JVM、lint 和正式签名构建通过；APK 原始 39 个网页资源逐一核验。适配测试覆盖所有权、两个主机、重载、迟到注册、错误指纹、缺少目标模块、原工厂仅执行一次和文档代次握手。

部分旧回归依赖短时钟或立即开始后台任务，本轮改用明确的工作开始条件、准备好的环境和注入时钟；未放宽生产超时或高亮预算。

页签偏好采用异步 `localStorage`。正常后台及进程重启已通过，点击后立即强杀进程可能恢复前一个选择。模拟器重启检查先按 Home，等六秒让浏览器完成界面偏好提交，再强制结束并重启。没有增加点击路径中的同步写盘。

Windows 实际客户端、Pocket 真机未取得本轮证据，仍需实机验收。普通浏览器和旧 Pocket 的可选 SDK 返回空、Hermes 原生入口兼容已有测试证据；它们不能代替 Windows 真机或 Android 真机结果。
