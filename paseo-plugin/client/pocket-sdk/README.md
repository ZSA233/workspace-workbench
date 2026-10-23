# Pocket 插件接口 v1

给已经安装的 Paseo 插件提供可选的 Pocket 客户端增强。SDK 无运行时依赖，不包含 React、Android 或 Workbench 业务代码；由插件自己的构建过程打包。

首版能力：`ui.panel.right-sidebar`。Pocket 0.1.11 配合受支持的 Paseo Web 0.12.0 提供该能力；普通浏览器、桌面、官方原生客户端和旧 Pocket 返回 `null`，保留插件原有入口。

## 接入

将本目录放到自己插件的 `client/pocket-sdk/` 下，导入 `index.ts`。Paseo 要求插件本地模块位于 `client/`、`server/` 或 `shared/`；无需额外安装、下载脚本或发布一个 Pocket 扩展包。

```ts
import { connectPocket } from './client/pocket-sdk/index';

export default function contribute(client) {
  // 先按普通 Paseo API 注册面板，Component 沿用现有组件。
  const removeWorkspace = client.addWorkspacePanel({
    id: 'inspector-workspace', title: 'Inspector', icon: 'GitBranch',
    context: 'workspace', locations: ['explorer'], Component: Inspector,
  });

  const pocket = connectPocket(client);
  const panel = pocket?.ui.registerPanel({
    id: 'inspector', title: 'Inspector', icon: 'GitBranch',
    location: 'right-sidebar',
    content: { workspacePanelId: 'inspector-workspace' },
  });

  return () => {
    pocket?.dispose();
    removeWorkspace();
  };
}
```

已有插件应将 `pocket.dispose` 加入现有清理流程，不替换其他注册的清理。窗口销毁、插件卸载和重载也会自动清理本次注册；显式清理可重复调用。

## 接口

- `connectPocket(client)`：使用实际传入的 Paseo 客户端上下文，返回 `PocketExtensionClient | null`。同一个客户端重复连接返回同一接口。不要传入自己拼出的主机或插件身份。
- `protocolVersion`：当前为 `1`，独立于 APK 版本。`supports(name)` 对不支持的能力返回 `false`。
- `context.getSnapshot()`：当前 `hostId`、`workspaceId`、可选 `agentId` 的只读快照。上下文未就绪、当前正在查看其他主机或连接已释放时返回 `null`。
- `context.subscribe(listener)`：只在上下文实际改变时通知，返回取消订阅函数。使用 ID 关联数据，不按目录名、显示名称或列表序号关联。
- `ui.registerPanel(contribution)`：声明一个面板，返回注册句柄。`id` 在当前插件实例内唯一，`location` 首版仅支持 `right-sidebar`。`title` 是插件提供的本地化文字，`icon` 使用 Paseo 支持的图标名。
- `content.workspacePanelId`：当前插件已经注册的 Workspace 面板；不能引用其他插件的组件。
- `content.agentPanelId`：可选的 Agent 面板。当前会话属于当前主机及 Workspace 时使用；否则显示 Workspace 面板。
- `registration.update({ title?, icon?, enabled? })`：原位更新展示信息，不改变注册 ID、位置或内容引用。`enabled: false` 暂时隐藏入口。
- `registration.dispose()`：移除此项。`pocket.dispose()` 移除本连接全部注册和订阅。

注册可以在 Paseo 插件初始化时立即进行；Pocket 等待宿主发布实际安装实例后展示。稳定的注册 ID 用于记住用户选择，加载代次用于防止旧实例覆盖新实例。

面板仍获得普通 Paseo props、主题、RPC、连接和查询缓存。首次打开才加载组件，隐藏时应停止无用工作；Pocket 当前最多保留两个最近打开的面板实例，业务状态应保存在插件自己的有界状态或缓存中。

接口为可信的已安装插件提供 UI 扩展与生命周期归属；它不声称隔离同一网页内的任意 JavaScript，也不增加设备权限。原生文件保存继续使用已有保存桥。

未来的会话徽标、菜单等采用新的能力和方法；插件不要依赖 Pocket 内部的页面选择器、模块编号或适配实现。

完整的独立示例插件用于自动化验收，位于 `scripts/fixtures/pocket-example/`。它通过同一接口注册多个面板、使用自己的 RPC，并验证查询缓存与生命周期。
