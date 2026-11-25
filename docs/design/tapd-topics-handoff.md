# TAPD 缺陷接入与 Workbench 话题页

用户在 Workbench 的「话题」页查看分配给自己处理的 TAPD 缺陷，按需勾选缺陷正文、评论或附件，并手动发送至 Paseo 会话。当前钉钉话题已由 Communication-Service 采集，Workbench 通过档案 v2 读取。TAPD 沿用这个分工。

## 两端分工

| 组件 | 职责 |
| --- | --- |
| Communication-Service（`communications-service`） | 实现 TAPD 来源插件，完成应用配置、账号授权、项目绑定、定时同步和取消授权。保存缺陷及版本，向已授权的 Workbench 调用方提供列表、详情和可选原件。 |
| Workspace Workbench | 在「话题」页读取同一资料库中的 TAPD 待办、详情和原件。复用现有行内展开、勾选、材料预览、目标会话选择和回执查询。 |

Communication-Service 复用来源插件的登记、能力声明和后台任务管理。缺陷以独立业务对象保存，保留 TAPD 项目、编号、状态及版本。接口由 `api/routes/issues.py` 和 `api/models/issues.py` 定义，沿用档案 v2 的响应和鉴权约定。服务侧参考 `docs/SOURCE_PLUGINS.md` 和 `docs/reference/http-api.md`。

## 「话题」页布局

三种草案使用现有钉钉行样式、行内展开及底部「已选材料」区。差别在来源入口和列表组织。草案允许从两边勾选材料，切换来源时保留本轮选择。

```text
顶部文字页签（当前实现）
  话题
  钉钉话题   TAPD 缺陷
  ━━━━━━━
  搜索当前来源   关注群／TAPD 项目   刷新
  □ 当前来源的记录
  已选材料                         发送到会话

同屏分组
  话题
  搜索话题或缺陷                    刷新
  钉钉话题
    □ 下载附件后文件名丢失           14:23
  TAPD 缺陷                         分配给我
    □ 下载附件时保存文件名丢失        14:32
  已选材料                         发送到会话

同一列表
  话题
  搜索话题或缺陷   [全部来源 ▾]     刷新
  □ 下载附件时保存文件名丢失         TAPD · 14:32
  □ 下载附件后文件名丢失             钉钉 · 14:23
  已选材料                         发送到会话
```

采用**顶部文字标签**，默认进入钉钉话题，用下划线标明当前来源。TAPD 标签内显示项目筛选、同步时间和打开档案服务的入口。两个来源的选材汇入同一个底部材料区。

## TAPD 授权与同步

1. **用户态 OAuth。** 从 Workbench 的 TAPD 来源设置打开档案服务，在该页面发起授权。回调由 Communication-Service 接收并核对发起用户和授权项目，凭据保存在服务侧。Workbench 显示服务返回的账号、项目授权和同步状态。部署时在测试租户确认开放应用安装、回调地址、可读字段和续期能力。官方用户态文档给出的到期流程是取得新授权码，后台长期同步以实际可续期能力为准。 [TAPD 用户态授权](https://open.tapd.cn/document/api-doc/API%E6%96%87%E6%A1%A3/%E6%8E%88%E6%9D%83%E5%87%AD%E8%AF%81/%E7%94%A8%E6%88%B7%E6%80%81.html)
2. **首版按项目定时拉取。** 以已验证的 TAPD 登录账号和授权项目读取「我的待办缺陷」，默认范围为分配给我处理的缺陷。TAPD 的用户待办接口按 `workspace_id` 分页，使用用户态 OAuth Token。首次同步、后台定时任务和手动刷新共用任务，按账号、项目和缺陷 ID 去重。完整同步成功后移出已改派或不再属于待办的记录。部分失败时保留上次成功的结果并标明同步状态。 [TAPD 用户待办缺陷](https://open.tapd.cn/document/api-doc/API%E6%96%87%E6%A1%A3/api_reference/user/get_user_todo_bug.html)
3. **Webhook 可在支持的部署中加速刷新。** 服务收到已验证的项目缺陷事件后，触发同一套用户范围复核和读取，定时同步负责补齐漏掉的事件。上线条件是租户具备事件订阅权限，并且 TAPD 能访问配置的回调地址。 [TAPD 事件订阅](https://open.tapd.cn/document/api-doc/%E5%BF%AB%E9%80%9F%E5%85%A5%E9%97%A8/%E5%BC%80%E5%8F%91%E5%BA%94%E7%94%A8/%E4%BD%BF%E7%94%A8Webhook-%E4%BA%91%E7%AB%AF.html)

## Workbench 的服务接口

Communication-Service 0.2.132 已提供缺陷接口。Workbench 后端沿用项目现有档案服务连接，从 `/v2/archive/libraries/{lib}/sources/tapd%3Aissues` 读取，`lib` 为所选资料库。同一操作者管理的客户端需由服务部署启用 `AI_ASSISTANT_ISSUE_MACHINE_READ=1`，并使用现有服务 Token。每次读取的账号和项目范围由档案服务核对。

| 读取路径（相对来源） | 用途 |
| --- | --- |
| `issue-source` | 读取账号授权、项目、插件和同步状态。 |
| `issues?view=todo` | 通过 `projectId`、`query` 和 `cursor` 查询分配给已授权账号的缺陷。缺陷编号和 ID 保持字符串。 |
| `issues/{id}?version={version}` | 展开时读取列表上对应的版本，核对选择时读取当前版本。 |
| `issues/{id}/versions/{version}/attachments/{attachmentId}` | 读取所选版本的原件。栅格图片使用 `view=preview` 取得原图和检查后的媒体类型。 |

登录授权、重新授权、解除绑定及手动开始同步走档案服务的同源浏览器流程。通过 Access 等网关发布档案服务时，在 Workbench 连接设置的「档案服务公网地址」填写带路径前缀的 HTTPS 入口。来源设置通过该入口打开当前资料库的 TAPD 页面，刷新按钮更新服务内已有的结果。

## 共用发送流程

勾选后，钉钉话题和 TAPD 缺陷都进入「已选材料」。用户在同一个「发送到会话」窗口预览材料、填写本次说明，并选择当前会话、项目已有会话或新建会话。显式确认后由 Workbench 通过 Paseo 发送。新会话继续使用现有模型、推理强度和权限选择。

实现时将 TAPD 所选材料接入 `TopicMaterials` 的预览与冻结过程，复用 `TopicSendDialog`、`topic-targets.ts` 和 `topic-sessions.ts` 的目标及投递逻辑。列表同步只更新展示，勾选固定到用户已看到的内容版本。发送前发现改派、撤权或材料版本变动时，提示核对并重新选择。投递结果未知时通过原回执核对。

## 联调验收

- Communication-Service 在隔离测试租户验证授权、重新授权、项目同步及评论和原件的实际可读范围。
- Workbench 用协议夹具和隔离 Paseo 宿主验证页签、窄屏、搜索、跨来源选材、版本变动、撤权，以及已有和新建会话的手动发送。
