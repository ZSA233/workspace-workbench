# Pocket 网页扩展维护

Pocket 0.1.11 在官方网页包之外安装文档启动脚本。原归档、页面资源、签名与校验值保持原样；网页更新仍走现有验证和安装流程。

## 分层

- `pocket-extensions-core.js` 管理 SDK 连接、安装实例归属、注册、能力与上下文，不依赖 DOM 或 Android。
- `pocket-extensions-paseo-0.12.js` 是版本适配器，负责宿主入口、Portal、右侧栏交互和选择记忆。
- `pocket-extensions.js` 装配和管理单个文档生命周期，向网页开放 `window.Pocket`。
- `PocketExtensionsBridge` 只传递文档握手、前后台、侧栏可见性和返回键，不接收设备命令。现有文件保存和选图桥保持独立。

插件 SDK 与接入文档在 `paseo-plugin/client/pocket-sdk/`；插件通过其安装实例复用宿主的 RPC、Paseo API、查询缓存、主题和状态 Provider。适配器不新建 React renderer、WebView 或业务连接。

## 0.12.0 适配

精确入口资源：

```
_expo/static/js/web/index-07fb71ae403dd83a2c7484a3338718f8.js
SHA-256 0551012c13e098ebdd9ba96ef639952b84ba25a15e766d41b215c20841bd3381
```

Native 安装前核对已验证资源清单，JS 再核对版本和指纹。仅在 Metro 启动前临时接入模块注册，包装插件注册表和移动侧栏两个目标的初始化。取得目标定义后立即恢复原注册函数；DOMContentLoaded 时仍缺目标则停止增强并恢复。宿主工厂只执行一次，适配异常不能重试或吞掉宿主原异常。

内部模块映射只存在于版本适配器，不作为 SDK 接口。React Portal 保持在宿主组件树中；面板使用对应安装实例的 Provider。DOM 观察只用于首次寻找侧栏节点，找到后立即断开，最多等待三秒；没有周期页面扫描。

Paseo 0.12 的插件导航工厂 `3907` 将 `openPanel(..., {location: 'explorer'})` 路由到桌面 pane。适配器只为当前主机、Workspace、实际注册的侧栏面板将此调用接回移动侧栏；其他导航仍调用原函数。导航包装与注册表包装一同释放。局部 React 错误边界仅停用扩展内容，原侧栏不在此边界内。

侧栏位置按主机、Paseo Workspace 和稳定注册 ID 记忆，最多保留最近 256 个选择。未加载的插件不会因为一次暂缺而被当作卸载。有效完整目录中的 Workspace 移除或有效插件清单中的卸载才清理相应记录。状态记录不包含凭据或文件内容。

选择偏好使用 `localStorage`，WebView 的磁盘提交是异步的。正常离开前台和重启已验证；点击后立即强杀进程可能恢复前一个选择。它是可丢弃的界面偏好，不在点击路径加入同步磁盘等待。

## 添加后续网页版本

1. 保留当前适配器，新增对应版本的适配器及精确资源指纹。不能仅因为版本字符串相同而复用模块编号。
2. 从锁定官方归档确认模块导出及 Provider 关系，更新适配器映射与结构验证。保持接入目标数量有界，不增加全表扫描。
3. 验证真实 Workbench 在侧栏内读取 RPC、会话及 Workspace 上下文、主题、文件／Diff 导航和卸载。新页面跳转不算侧栏挂载通过。
4. 运行 SDK、适配器、网页包、Android 和隔离宿主回归，在 QA 模拟器交错测量至少 20 个样本。

未知版本或指纹不安装增强，原文件／变更栏和插件原菜单入口继续工作。适配诊断仅记录有限事件代码，不记录会话、目录、URL、令牌或控制台正文；不反复弹出提示。

## 设备验收

```sh
node android-app/scripts/verify-device-extensions.mjs --serial emulator-5580 \
  --output /tmp/pocket-device-extensions
```

仅使用已安装的 `dev.paseo.pocket.qa`，重置 QA 数据并创建自己的隔离 TLS 宿主和项目注册表。不会触碰日常 Pocket 或普通 Paseo 宿主。SDK 示例插件只在显式测试模式下加载。

双插件的实际网页验收：先运行 `POCKET_TEST_WORKBENCH=1 POCKET_TEST_EXTENSION_HELPER=1 node android-app/scripts/serve-isolated-paseo.mjs > /tmp/pocket-extensions-host.log`，再运行 `node android-app/scripts/verify-browser-extensions.mjs --fixture /tmp/pocket-extensions-host.log`。测试会重载并移除该隔离宿主上的示例插件；不会修改正常宿主。

性能对比使用 `benchmark-extensions.mjs --serial EMULATOR --fixture LOG --trials 20`。准备同签名的两个独立 debug 包 `dev.paseo.pocket.qa.baseline`（上一版）和 `dev.paseo.pocket.qa`（当前版），只允许清除这两个 QA 包的数据。使用不加载示例插件的独立 fixture，交错运行，测量期间不要运行构建或其他设备测试。冷启动后先向实际 WebView 发送一个触摸手势取得 DOM 焦点，再计量交互，避免把未聚焦时按设计暂停的后台查询当成加载慢。
