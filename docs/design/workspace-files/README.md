# Workspace 文件工作台：可行性与布局草稿

调研日期：2026-10-22。此目录保留前期设计与本地交互演示；草稿中的文件、路径与进度仍为示例。已实现的单树文件 Tab、传输及清理规则见 [使用说明](../../../paseo-plugin/FILES.md)，实际验收证据见 [验收记录](../../workspace-files-verification.md)。

## 结论

能够在当前插件中实现以 Workspace 为根的远程文件管理。它应作为现有 Workbench 的「文件」视图，与当前 Workspace 选择器共用上下文，而不是另建一套工作区。

文件树、目录切换、重命名、删除、远程复制和移动的复杂度适中。完整的上传下载，包括真实字节进度、取消、失败重试、大文件和手机保存，需要独立的传输任务模块，复杂度中等偏高。不能把 Paseo 的会话附件上传直接视为已经具备目标目录上传。

当前插件依赖的 SDK 为 `@getpaseo/plugin@0.10.2`，manifest 支持 `>=0.8.0`；项目内 Android 网页资源锁定 `@getpaseo/server@0.12.0`。在线文档已经包含要求 `>=0.13.0` 的能力，因此设计不能默认这些能力在现有部署中可用。

## 已确认的基础与缺口

| 内容 | 已有依据 | 对本次功能的意义 |
| --- | --- | --- |
| 现有面板与主区域 | `paseo-plugin/index.client.tsx` 注册 Explorer、workspace 面板及 surface | 可以在现有 Workbench 增加「文件」页，也能提供展开视图；Explorer 在宿主中的物理位置由宿主决定 |
| Workspace 根目录 | `server/backend/workspace-directory.ts` 的 `mainWorkspace()`，以及 `client/model.ts` 的 `sourceRoot` / `treePath` | 主工作区以 `sourceRoot` 为根；普通 Workspace 以自己的 `treePath` 为根，不需要从主目录逐层寻找 worktree |
| 多仓库目录 | Workspace 记录保存 `repositories[].worktreePath` | 文件树展示实际目录，仓库节点加标记；非 Git 文件同样可见，不按 Git 变更列表生成树 |
| 插件服务端文件访问 | Node 后端、现有 `server.handle()` 与 `useRpc()` | 常规文件操作可走插件的已认证 RPC，无需另开公开上传端口或要求用户配置 SSH |
| Paseo 底层文件接口 | 已安装 `@getpaseo/client` 的 `daemon-client.d.ts`：`listDirectory`、`readFile`、`createFileEntry`、`renameFileEntry`、`duplicateFileEntry`、`deleteFileEntry` | 宿主具备文件管理基础，但不能据此认定插件公开 API 已暴露这些方法 |
| 公开 SDK 限制 | 已安装 `client/dist/index.d.ts` 的 `PaseoApi` 没有 files 命名空间；插件 client 导出也没有文件选择/保存 API | 现有版本需要插件自己的目录操作 RPC 和网页端平台适配；完整原生客户端支持要额外验证宿主接口或扩展桥接 |
| 底层附件上传 | `DaemonClient.uploadFile()` 使用二进制帧；`FileUploadInput` 接收文件名、bytes、chunkSize | 输入没有 Workspace 目标目录、进度回调或取消信号，不能原样满足需求，也不能在 UI 用定时器冒充真实传输进度 |
| Android 文件选择 | `android-app/app/src/main/java/dev/paseo/pocket/MainActivity.kt` 和 `WebSession.kt` 已接 `onShowFileChooser` | 自有 Android WebView 壳可复用系统选文件入口，但下载保存、目录上传、后台持续传输还需独立验收；不能据此推断 Paseo 原生 iOS/Android 也已支持 |

上游参考：[插件能力与平台限制](https://paseo.sh/docs/plugins/reference)、[插件运行方式](https://github.com/getpaseo/paseo/blob/main/public-docs/plugins/index.md)。本次仅做源码/API 调研和独立草稿校验，没有运行真实宿主上传下载验收。

## 草稿方案

`workspace-file-manager.html` 是供对话内预览的交互草稿，包含四个视图：

1. **侧栏文件树**：现有 Workspace 选择器下增加「文件」，树占用原 Workbench 面板。传输队列固定在面板底部，可折叠；预览使用旁边的主区域。推荐作为默认入口。草稿采用左树右内容的阅读顺序；实际 Explorer 侧别服从宿主布局。
2. **完整文件工作台**：从同一入口展开，左侧目录树、右侧目录清单，下方横向传输列表。适合一次上传很多文件、按目录整理和查看进度。
3. **双工作区对照**：左右各自选择主工作区或某个 Workspace，以树展示各自根目录，显式复制文件到另一边。适合从主工作区分发资料，属于后续可选布局。
4. **手机文件视图**：沿用相同 Workspace 选择器，单列树和底部传输抽屉。触控使用「上传」和「更多」菜单，避免依赖右键或桌面拖拽。

三个桌面方案都是现有 Workbench 的一种文件视图，不需要注册另一套 Workspace。双栏对照的另一侧是文件操作目标，不会切换执行会话或扩大 Agent/Review 范围。

草稿可以切换 Workspace、展开目录、选择目标目录、显示拖入高亮、演示传输队列、暂停/重试/取消示例任务、打开文件菜单和查看同名冲突。演示操作只改页面内的样例状态；不会读取本机文件内容或写入远程文件。

静态草图：[侧栏文件树](previews/sidebar-tree.png)、[完整文件工作台](previews/full-workbench.png)、[双工作区对照](previews/two-workspaces.png)、[手机文件树](previews/mobile-files.png)、[手机传输抽屉](previews/mobile-transfers.png)、[同名文件处理](previews/name-conflict.png)。

## 共同交互约定

- 根目录绑定 `{hostId, projectConfig, workspaceId}`，由服务端解析实际路径。不能信任客户端提供的绝对路径。
- 选择某个 Workspace 后，直接显示它自己的根目录；切回主工作区直接显示 `sourceRoot`。各自记忆展开节点和当前目录。
- 拖到目录行就上传到该目录；拖到根节点或明确的根目录空白区就上传到根。上传按钮使用当前选中目录，未选目录时使用根。拖入文件行时明确显示其父目录。
- 拖拽只在可写目录上显示落点和目的地；悬停可展开目录，尚未释放时不创建任务。桌面外部文件与树内移动区分处理。
- **任务在加入队列时固定目的 Workspace 和目录。** 切换视图只改变浏览对象，不改变已经排队的目的地。
- 所有队列项显示方向、文件名、所属 Workspace、相对路径、已传/总字节、状态，以及可用的速度/剩余时间。未知总量时使用不确定状态，不能编造百分比。
- 已发送完不等于已保存完：上传要在服务端验证并提交后才显示完成；下载要区分「交给浏览器/系统保存」和可确认的保存完成。
- 同名默认暂停该项，提供跳过、保留两份、替换和明确的「应用于本批冲突」。不默认覆盖。文件菜单始终有可见的更多入口，手机使用相同命令。
- 文件管理内部的复制/剪切使用带源 Workspace 身份的操作记录。跨 Workspace 默认复制，移动需显式选择；剪贴板文本复制与文件复制是两种动作。
- 删除用户文件采用预览和可恢复设计，恢复区放到插件状态目录；若暂时无法可靠恢复，明确确认永久删除。不得通过文件菜单删除 Workspace 根、仓库根、`.git` 或 Workbench 内部元数据，也不得借此绕过 Workspace 生命周期流程。
- 展示整个 Workspace 目录不会自动加入仓库配置、执行范围或审核集。普通文件变化交给现有观察失效机制处理。

## 建议实现边界

### 浏览与常规操作

新增独立的 `server/backend/` 文件服务模块和 `shared/` RPC 契约，入口只负责组装。目录按需展开、分页，客户端虚拟化；监听只覆盖当前浏览范围并沿用需求租约，避免为每个文件或队列 tick 执行 Git。

以规范化后的真实根目录检查每次操作，阻止 `..` 越界、外部符号链接写入和指向共享运行时的误操作。显示符号链接自身，不自动把链接目标当成可写子目录。复制/移动使用受限后台任务和冲突检查，不用 shell 拼接命令。已存在的 Workspace 记录、ID 和历史字段保持不变。

### 传输

优先验证一条可在当前版本落地的路径：浏览器 `File` / `Blob` 分块读取，通过现有已认证插件 RPC 发送有界块（例如从 256 KiB 起），服务端写入独立临时文件，以 `uploadId + offset` 确认已持久化字节，再校验并原子提交。Base64 会增加传输开销，适合先建立完整流程；后续若采用宿主正式暴露的二进制通道，可替换载荷层。

任务具备稳定身份、状态、目的根身份、大小限制、空闲回收、取消和查询接口。重复分块与超时后的 finalize 必须可以核对，不能盲目重复覆盖。大文件控制并发和内存，不能整文件 Base64 到内存或一次塞进 RPC。断线后先查询服务端的接收偏移；浏览器重开后可能必须重新选择本地原文件，不能承诺无条件后台续传。

下载同样需要受控读取与平台保存适配。网页小文件可以先组装 Blob 交给浏览器，但大文件不能无限堆内存；原生选文件、保存到设备和 App 后台运行需要独立方案。现有 MCP 网关服务于 Agent，不能当作未经设计的公开上传入口。

### 分期

| 阶段 | 范围 | 难度 |
| --- | --- | --- |
| 能力验证 | 当前宿主版本、指定目录分块上传、真实进度/取消、断线核对、手机下载保存 | 必须先验证的接口边界 |
| 首版 | Workspace 根切换、懒加载树、拖拽/按钮上传、单文件下载、传输队列、新建、重命名、删除与冲突处理 | 中等 |
| 完善 | 多选、目录上传、内部复制剪切粘贴、批量移动、目录下载打包、重试与恢复体验 | 中等偏高 |
| 可选扩展 | 双 Workspace 对照、跨空间大目录任务、原生后台传输 | 较高，可按实际使用决定 |

建议先采用「侧栏文件树」作为默认入口，预留「展开到完整文件工作台」，共用同一个目录服务和队列。双栏对照可以后续添加，不影响首版架构。

## 验证范围

本轮验证仅针对独立草稿的布局与页面内交互。具体结果见 `preview-checks.json`。已通过插件 `npm --prefix paseo-plugin run typecheck`。这些结果不构成实际 Paseo 宿主、弱网、大文件或真实 Android/iOS 设备上的上传下载证据。
