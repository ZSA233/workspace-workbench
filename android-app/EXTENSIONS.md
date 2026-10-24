# 官方侧栏与原生网页桥

Paseo Pocket 从 0.1.12 起内置官方 Paseo Web 0.13.0。右侧 Explorer 的 Tab、“＋”菜单、面板选择和保留均由 Paseo 实现，不再注入侧栏、挂接内部模块或提供 `window.Pocket` SDK。

## 插件接入

插件通过官方客户端 API 注册 `addWorkspacePanel({ locations: ["explorer"], ... })`。用户从右侧侧栏的“＋”选择插件面板，标签页随 Paseo 的 Workspace 布局保存。Workbench 已注册 Workspace 与 Agent 面板；官方“＋”菜单添加 Workspace 面板，不自动绑定当前 Agent。

普通浏览器与 Pocket 使用相同的官方侧栏入口，不需要额外客户端扩展。以前复制 Pocket SDK 的第三方插件应保留原有官方面板注册并移除 SDK 调用；旧 SDK 在新 Pocket 中连接不到 `window.Pocket`，会返回 null。

已安装的 0.12 网页不会强制切换或清除存储，可以从“网页更新”手动升级。0.12 保留插件原菜单入口，不再获得旧注入提供的侧栏标签。

## 独立保留的原生能力

- 文件保存：固定本地 HTTPS 来源的独立消息桥，使用 Android 系统文件保存器。
- 选图兼容：只处理已验证网页版本的图片选择边界，保留原始文件及 Paseo 的草稿、发送路径。
- 连接诊断：订阅现有运行状态，不改写侧栏、DOM 或传输；能力不匹配时降级为原生加载诊断。

选图和连接诊断支持已验证的 0.12.0 与 0.13.0；其他版本保留原网页功能并停用相应详细适配。网页包仍完整校验签名和资源，独立桥随 APK 维护。

## 隔离验收

`verify-device-sidebar.mjs --serial QA_EMULATOR` 使用 `dev.paseo.pocket.qa` 和隔离 Paseo home，验证官方“＋”、Workbench 标签、页面重开、原生桥及选择恢复。

`verify-browser-sidebar.mjs --fixture LOG` 连接 `serve-isolated-paseo.mjs` 生成的隔离主机，验证普通浏览器无需 Pocket API 即可打开插件侧栏。

失败注入、测试任务和进程重建只用于 QA 包与隔离宿主，不重载正常插件，不清除日常 Pocket 数据。以前 0.1.11 的扩展验收文档作为历史记录保留。
