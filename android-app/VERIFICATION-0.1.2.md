# Paseo Pocket 0.1.2 发布验收

日期：2026-10-21。版本 `0.1.2` / versionCode `3`，包名 `dev.paseo.pocket`。
本次发布 APK 的版本及签名身份已经从 GitHub 下载后独立核验。

## 公开产物与源码

- [GitHub Release](https://github.com/ZSA233/workspace-workbench/releases/tag/android-v0.1.2)
- [签名 APK](https://github.com/ZSA233/workspace-workbench/releases/download/android-v0.1.2/paseo-pocket-0.1.2.apk)
- [SHA256SUMS](https://github.com/ZSA233/workspace-workbench/releases/download/android-v0.1.2/SHA256SUMS)
- [版本清单](https://github.com/ZSA233/workspace-workbench/releases/download/android-v0.1.2/release.json)
- [成功的发布 Actions](https://github.com/ZSA233/workspace-workbench/actions/runs/39603886472)

应用 tag `android-v0.1.2` 固定在 `cd4bd7637890e88c89752c3c2764e239402c9bb7`。
发布工具使用 `f8666d41705f427da8e78d16f775f1bf4e8c039f`；两者均写入版本清单。
APK 大小 11,972,519 字节，内置完整 Paseo Web 0.12.0，39 项静态资源。

APK SHA-256：`27766baf97d7c9abf787fd091f1c60df05513acfde3d27b8c6883948757e7b63`

证书 SHA-256：`2da3e1a4bf8a44e0e883c2d6989133c54857544b6caf9a35df5d54d3e01e7d69`

证书与 0.1.0 / 0.1.1 相同，沿用持久签名；密钥及密码只配置在 Actions Secrets，不进入源码或 Release。
本次未修改 App 的业务交互、网页版本、Paseo 宿主或 relay。

## 实际验证

| 检查 | 结果 |
| --- | --- |
| 发版脚本测试 | 本地及成功发布工作流均 15 项通过；覆盖版本、重复准备、真实 Git 原子推送失败、tag 保护、草稿重试及产物损坏 |
| 网页资源工具 | 本地 5 项通过；普通 Android CI 5 项通过；正式发布任务 4 项通过、1 项因下载缓存尚未生成而条件跳过 |
| Android JVM / lint / 构建 | 本地 JVM 14 项通过；云端 JVM、lint、持久签名构建全部通过，lint 保留既有 warnings |
| 普通 Android CI | [首次接入](https://github.com/ZSA233/workspace-workbench/actions/runs/39602308961) 与 [修正后](https://github.com/ZSA233/workspace-workbench/actions/runs/39603873411) 均成功，没有自动创建 APK Release |
| 插件原有 CI | [实际运行](https://github.com/ZSA233/workspace-workbench/actions/runs/39602308967) 641 项：636 通过、5 条件跳过、0 失败；TypeScript 检查及插件打包通过 |
| 草稿产物 | 工作流上传后重新下载三个文件并核对摘要，再公开 Release；临时签名文件清理成功 |
| 公开下载 | 发布后使用不携带 GitHub 登录凭据的 curl 下载 APK 成功；APK 与版本清单均通过 SHA256SUMS |
| 包信息 | aapt 验证版本 0.1.2 / 3、包名、minSdk 26、target / compile 37 |
| 签名 | apksigner 验证 APK v2 签名，单一 RSA 3072 签名，与公开证书指纹一致 |
| 本地网页 | 对公开下载 APK 重新逐项验证 39 个文件的大小和 SHA-256，通过 |
| 发布渠道 | Release 为公开正式版；仓库全局 Latest 仍为插件 v0.5.1 |

正式发布任务中条件跳过的是依赖预下载官方归档的镜像集成测试；该测试已在本地及普通 Android CI 中通过。
正式构建随后完成了官方归档验证、网页生成和 APK 逐文件校验，没有跳过安装包资源校验。

## 首次失败与重试

[首轮运行](https://github.com/ZSA233/workspace-workbench/actions/runs/39603031009) 已完成 APK 构建、签名、上传与草稿字节核验，
但发布脚本通过 REST 按 tag 查询不到草稿，因而停止公开。草稿和私有签名文件的处理均符合预期，未发布不完整版本。

修正后改用能同时查询草稿和公开版本的 GraphQL 查询，增加对应回归校验。
手动工作流将应用源码固定检出到原 tag，发布工具使用工作流本身的提交，允许修复工具后重试。
成功重试期间没有移动 tag，没有修改应用源码，也没有创建第二个 Release。

## 维护与证据边界

使用方式见 [Android 发版流程](../docs/releasing-android.md)。版本源仅为 `version.properties`，
本次版本提交由 `scripts/release-android.mjs --version 0.1.2 --publish` 自动生成。

界面实机及模拟器证据继续参见 [0.1.1 验收](VERIFICATION-0.1.1.md)；本次未重新声称完成手机 UI、长期性能或真实模型测试。
本次没有重载用户插件、重启日常 Paseo 或改动 relay 部署。

本地日志和从 GitHub 下载的产物位于忽略目录 `artifacts/`，未将私钥、配对材料、手机截图或构建缓存提交到 Git。
