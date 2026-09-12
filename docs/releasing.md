# Workspace Workbench 发布说明

Workspace Workbench 使用 `MAJOR.MINOR.PATCH` 版本号。根目录的 `VERSION` 是唯一版本
来源，Python 包、Paseo 包和锁文件都必须与它一致。

## 升级并检查版本

按照公开兼容性影响选择最小升级范围：

```sh
make bump-patch   # bug 修复，不改变预期的公开 API
make bump-minor   # 向后兼容的新功能
make bump-major   # 不兼容的公开契约变化
make check
make release-check TAG=v0.1.1
```

升级命令只修改版本元数据，不会创建 commit、tag、Release 或远端变更。提交前请
检查 diff，并补充发布说明。

## 发布版本

```sh
git add VERSION pyproject.toml src/workspace_workbench/__init__.py \
  paseo-plugin/package.json paseo-plugin/package-lock.json
git commit -m "chore(release): v0.1.1"
git tag -a v0.1.1 -m "Release v0.1.1"
git push origin main v0.1.1
```

Release workflow 会检出指定 tag，运行完整测试和构建流程，发布带有
`SHA256SUMS` 的 Python 与 Paseo 附件，然后将通过验证的同一个 commit 推进到
`stable` 分支。它不会发布到 PyPI 或 npm。手动触发 workflow 时也必须指定已经
存在的 tag，并通过同样的版本检查。

已发布的版本号不能重复使用。如果某次发布在 tag 创建后失败，应修复代码并使用
新的版本号重新发布。

## 安装和更新 Paseo 插件

将 `OWNER` 替换为公开仓库所属的 GitHub 账号或组织。Paseo v0.8 支持 Git 管理的
插件来源：

```sh
paseo plugin install OWNER/workspace-workbench:paseo-plugin \
  --ref stable \
  --id workspace-workbench-paseo \
  --json
paseo plugin update workspace-workbench-paseo --json
```

`stable` 跟随最近一次通过验证的发布版本。开发分支使用 `main`：

```sh
paseo plugin install OWNER/workspace-workbench:paseo-plugin \
  --ref main \
  --id workspace-workbench-paseo \
  --json
paseo plugin update workspace-workbench-paseo --json
```

`paseo plugin update` 是显式的拉取、构建、验证和激活流程，不会在后台自动更新。
查看插件的 Git 来源、ref 和 commit：

```sh
paseo plugin ls workspace-workbench-paseo --json
```

插件 manifest 会使用提交的 lockfile 执行 `npm ci`，然后在 Paseo 激活前运行类型
检查。插件构建命令会在 Paseo daemon 主机上执行，请只安装信任的仓库。

固定版本可以使用 `vX.Y.Z` ref 或对应的 GitHub Release 压缩包。固定 tag 不会通过
`paseo plugin update` 自动跳到下一个版本，升级时需要显式切换 ref。

## Release 附件

GitHub Release 会包含 Python wheel、源码包、
`workspace-workbench-paseo-VERSION.tar.gz` 和校验文件。Git 不可用、需要离线安装
或需要固定附件审计时，可以使用这些文件。压缩包不包含项目 JSON、SQLite 数据、
Socket、Agent 绑定或 secret。
