# Project Communications Service 0.2.0（Go）

独立常驻的项目沟通服务。钉钉消息采集、遗漏补读、附件、模型分析、候选和需求版本全部由本服务管理。它不导入 Paseo、Workbench、Git 或任何会话宿主代码，可以单独安装、启动、升级和停机。

Workbench 的“需求与反馈”扩展是 HTTP 客户端；关闭页面、重载插件和停用界面连接不会停止服务。未来独立 Web 后台和服务入口网关复用下列 API。本轮提供服务端、CLI 和 Workbench 客户端；独立 Web 后台尚未实现。

## 启动与数据

运行已构建的服务不需要 Node、Python 或 Workbench。DWS 是独立外部依赖。源码开发使用 Go 1.27。

```sh
go build -o ./bin/project-communications ./cmd/project-communications
./bin/project-communications serve
```

也可以解压当前平台的发布压缩包，直接运行其中的 `project-communications`。
服务以前台进程运行；`deploy/` 提供 launchd 和 systemd 用户服务示例，需自行修改安装路径后启用。
默认只监听 `127.0.0.1:47191`，数据根目录是 `~/.project-communications`：

```sh
project-communications serve --home /absolute/service-data --port 47191
project-communications status --home /absolute/service-data
project-communications projects --home /absolute/service-data
project-communications token --home /absolute/service-data
project-communications stop --home /absolute/service-data
project-communications version
```

也可使用 `COMMUNICATIONS_HOME`、`COMMUNICATIONS_PORT`。`token` 命令显示访问凭证，不应放入日志或提交到仓库。服务根目录使用 0700，Token、SQLite 和密钥文件使用 0600。模型 Key、App Secret 在服务端使用 AES-GCM 保存；主密钥也在服务数据目录，依靠操作系统文件权限保护，不等同于硬件密钥库。

目录：

```text
api-token                         API Bearer Token
projects.json                     独立项目注册表与运行开关
projects/<project-id>/            消息/FTS、任务、候选、需求版本、断点、附件
secrets/<project-id>/             模型和应用凭证
```

数据不存入 Workspace 记录，不依赖插件目录。SQLite 内核锁避免同一服务数据目录被两个进程同时占用；不使用 PID 文件杀进程。SIGTERM/SIGINT 会取消采集和分析，保留已落盘断点，重启恢复已启用项目。停机期间的数据能否补齐仍取决于钉钉的实际授权与数据保留范围。

## API v1 与网关

全部请求包括健康检查都要求 `Authorization: Bearer <api-token>`。所有响应禁用缓存。默认不开放浏览器 CORS；独立 Web 后台可通过自己的服务端访问 API。网关应转发 Authorization、保留 `/v1` 路径并使用 HTTPS，建议将上游保持为本机端口。Workbench 的服务地址允许路径前缀，网关需剥除该前缀后转发。

| 方法与路径 | 用途 |
|---|---|
| `GET /health` | 产品、API 版本、服务版本、实例身份 |
| `GET /v1/projects` | 项目列表与运行状态 |
| `PUT /v1/projects/:id`，`{"name":"项目"}` | 幂等注册项目；ID 不是文件路径 |
| `POST /v1/projects/:id/control`，`{"active":false}` | 暂停此项目的所有后台任务，已有资料仍可查看；true 恢复 |
| `POST /v1/projects/:id/actions` | 类型化领域操作，见 `shared.ts` |
| `POST /v1/projects/:id/deliveries/:id/claim` | 领取一次固定材料投递；再次领取不重放 |
| `POST /v1/projects/:id/deliveries/:id/finish` | 保存客户端接收回执（accepted / uncertain） |
| `POST /v1/shutdown` | 主动排空并停止服务 |

领域操作以 JSON `action` 区分：

- `snapshot`：配置版本、身份、能力、群、任务、候选、台账及独立未读/待确认数量。
- `configure`：携带 `revision` 和完整 `config`；可选 `modelKey`、`appSecret` 只写入凭证库，快照仅返回是否已设置。旧修订返回冲突，避免并发覆盖。
- `connection.check`、`auth.start`、`models.check`、`generation.check`、`analysis.retry`：立即返回持久化任务，进度从 snapshot 查询。
- `groups.search`、`groups.bind`、`groups.pause`、`groups.resume`、`sync.start`：明确绑定、暂停、恢复和补读项目群。
- `messages.list`、`messages.read`、`attachment.read`：检索原始依据和读取附件。
- `candidate.list`（游标分页与检索）、`candidate.read/ignore/snooze/preview/accept`：人工处理候选。accept 校验候选修订和正式需求版本，重试不重复入账。
- `requirement.list`：分页检索台账；`requirement.history`：读取不可变的需求版本。
- `delivery.preview/status`：固定材料、版本及客户端目标。服务不持有开发会话权限；发送由 Workbench 客户端在明确确认后处理。未知回执不自动重发。

普通领域操作返回 `{"result": ...}`，错误返回 `{"error":"..."}`。TypeScript 客户端 SDK 与 Go DTO、校验共同遵守 API v1；`testdata/protocol-v1.json` 冻结默认值和校验样本。客户端不能传入任意目录或可执行命令；项目 ID 只能包含字母、数字、下划线和连字符。默认最多 64 个监控群/项目，单次消息/CLI 输出、请求、模型响应及附件均有上限。

## 钉钉与模型

首期适配 DWS **1.0.68**。程序必须是 PATH 中的 `dws` 或显式绝对路径。自建应用 Client ID、Secret、Profile 和机器人 OpenBotId/robotCode 由项目配置指定；也支持 DWS 默认应用。不同应用使用独立 DWS 授权目录，避免更换应用时复用旧登录缓存。应用授权、版本检测、入群核对、普通消息订阅、遗漏补读、附件读取分别报告状态。登录成功或订阅就绪不能证明全量消息验收通过。

只采集用户绑定且已核实机器人入群的项目群。首次绑定从绑定时刻开始，普通消息无需 @。先保存消息再分析，按账号/群/稳定消息 ID 去重；固定补读窗口分页，只有窗口完整完成才推进断点，覆盖实时订阅可能漏掉的授权账号自身消息。成员状态未知或机器人离群会暂停新增采集。来源身份改变后必须重新绑定。

模型默认 `http://127.0.0.1:12345/v1`，使用 Chat Completions 兼容协议。不安装或切换模型；模型列表和实际生成测试各自独立。默认总上下文 128K、输出预留 8K，支持 256K、512K 和自定义上限。讨论分批摘要，保留证据 ID；模型失败不丢失消息。Token 采用保守估算。UTF-8 文本、支持的图片参与分析；每轮最多 4 张图片、每张 2 MiB，超限或无法解析会单独标注，原件仍可查看和投递。单个原件最多 8 MiB，单次投递附件合计最多 8 MiB。

钉钉真实权限申请、未 @ 全量接收及停机补齐验收留待授权后完成。本包测试使用隔离协议夹具，不声称真实企业消息能力已经验收。

## 开发、验证和独立打包

```sh
go test ./...
go test -race ./...
go vet ./...
go test ./internal/storage -run '^$' -bench BenchmarkBacklogSnapshotAndSearch -benchmem
./scripts/package.sh
```

构建结果位于 `dist/`，包括 macOS、Linux 的 arm64/amd64 压缩包和 SHA256SUMS；可用 `COMMUNICATIONS_BUILD_PLATFORMS=darwin/arm64` 只构建一个平台。
各包只包含二进制、说明和常驻服务示例。版本由 VERSION 管理，API 仍是 v1。独立 CI 使用 `communications-service/v*` 标签，与 Workbench 插件版本分开；本次实现不会自动发布或安装用户服务。

进程级最多 4 个短 DWS 操作、1 个模型生成请求；每个项目的同步和分析分别串行，长订阅单独管理。关闭页面、插件重载不参与服务生命周期。退出时先取消任务及拥有的 DWS 进程组，再关闭数据库并释放租约；排空期间 `/health` 报告 `state: draining`，新业务请求返回 503。

`SourceProvider`、`AnalysisProvider`、`RetrievalProvider` 使用 Go 接口和 context 取消。项目数据保持开放记录，写回时保留未知字段。插件只包含 TypeScript SDK、界面和 HTTP 连接器；修改协议时两端必须通过共享样本测试，不需要互相导入运行时代码。

`testdata/node-v1` 是 Node 0.1.0 生成的隔离样本，内含虚构凭证。测试验证 SQLite/FTS、消息和候选、需求历史、附件、AES-GCM 凭证、JSON 哈希及投递身份兼容；可选 Node 测试仅核验旧租约与加密格式，不是生产依赖。

## 从 Node 0.1.0 切换

1. 保留旧版安装环境，停止旧服务及其进程管理器，确认旧进程已退出。
2. 完整备份服务数据目录到目录之外，包含 SQLite、可能残留的 WAL/SHM、附件、授权目录、凭证和 API Token；不要在写入期间只复制主数据库文件。
3. 用 Go 版运行同一 `--home`，通过 `status`、项目列表和 Workbench 连接验证。Go 版复用原 SQLite 租约，无法与旧服务同时接管数据。
4. 需要回退时先停止 Go 版，恢复切换前的完整备份，再启动旧版。不要同时运行两个版本，也不要自动重发处于 uncertain 的材料投递。

Go 版直接读取旧数据，不重新生成消息或 Workspace ID，不清空断点或需求历史。新建的项目继续使用同样的数据布局。迁移验证、界面验证和真实钉钉验收应分开记录；单纯登录或 CLI 订阅就绪不能证明全量消息接收和停机补齐已经通过验收。
