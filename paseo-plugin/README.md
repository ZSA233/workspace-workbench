# Workspace Workbench Paseo 插件

插件将 Workbench 放在 Paseo 的 Explorer 中，Agent 对话仍保留在主区域。
对应的 Python 服务需要单独运行。

## Git 安装

将 `OWNER` 替换为 GitHub 仓库所有者：

```sh
paseo plugin install OWNER/workspace-workbench:paseo-plugin \
  --ref stable \
  --id workspace-workbench-paseo \
  --json
paseo plugin update workspace-workbench-paseo --json
```

开发分支使用 `--ref main`。Paseo 会先拉取代码、安装锁定的依赖、执行类型检查，
验证通过后才激活新版本。

## 本地安装

```sh
paseo plugin install /path/to/workspace-workbench/paseo-plugin --json
paseo plugin reload workspace-workbench-paseo --json
```

打开插件前，先使用项目配置启动服务：

```sh
workspace-workbench serve --config /path/to/project/workbench.json
```

如需 Agent 交接，请按[根目录 README](../README.md) 配置 `agent.provider` 和
`agent.bridge`，然后新建 coordinator Agent。已经存在的 Agent 会话不会被静默修改。

发布压缩包适合固定版本或离线安装。压缩包不包含项目配置、缓存、Socket、Agent
绑定或 secret。
