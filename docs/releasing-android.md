# Paseo Pocket Android 发版

Android、Workbench 插件和内置网页分别维护版本。日常 push / PR 执行检查，不发布 APK；
只有 `android-vMAJOR.MINOR.PATCH` tag 触发 Android 正式发布。插件的 `v*` 发布流程保持独立。

## 一次性签名配置

正式 APK 沿用持久密钥，以便用户直接覆盖升级。源码、证书指纹和产物公开，私钥与密码保存到
GitHub Actions Secrets。不要把签名配置、私钥或其 Base64 内容提交到仓库。

本机已有签名配置时，从仓库根目录执行：

```sh
node android-app/scripts/signing.mjs configure --repo OWNER/REPO --dry-run
node android-app/scripts/signing.mjs configure --repo OWNER/REPO
```

需要已登录的 GitHub CLI 和 JDK。脚本读取默认的 `~/.config/paseo-pocket/android-signing.properties`，
也可用 `--properties /private/path/signing.properties` 指定。它先验证证书指纹与仓库中的
`android-app/signing-certificate.sha256` 一致，再通过标准输入配置以下 Secrets，不打印其值：

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_STORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

fork 项目独立发布时，先运行 `node android-app/scripts/create-signing-key.mjs` 创建自己的密钥，
再对自己的仓库执行配置，明确添加 `--write-certificate` 更新公开指纹，并提交指纹变更。
新签名不能覆盖原项目签名的安装包；保留并备份各自的持久密钥。

## 准备与发布

先提交功能改动，合并到 `main`，同步远端并等待 CI 通过。
`android-app/version.properties` 是版本名及 versionCode 的唯一来源，Gradle 不再重复维护版本。

```sh
# 只准备版本文件，不提交、打 tag 或推送
node scripts/release-android.mjs --version 0.1.2
git diff -- android-app/version.properties

# 确认发版：提交版本文件，创建带注释的 tag，原子推送 main 与 tag
node scripts/release-android.mjs --version 0.1.2 --publish
```

脚本自动递增 versionCode；重复准备相同版本不会重复递增。
除预期的版本文件修改外，工作区须干净。版本倒退、远端 main 有新提交或已有同名 tag 时停止，
不强推、不覆盖 tag。推送明确失败时，仅清理本次创建且确定未到远端的 tag，保留版本提交供重试。
推送结果无法确认时，先检查远端；已经到远端的 tag 使用 Actions 重试。

发布工作流会验证 tag 与源码版本、main 归属、历次 Android versionCode，执行脚本测试、
网页资源测试、JVM 测试、lint 和正式构建。签名临时文件在 checkout 之外创建，完成或失败均清理。
APK 的包名、版本、持久签名及 39 个锁定网页资源通过校验后才进入发布。

## 产物与失败重试

GitHub Release 提供：

- `paseo-pocket-VERSION.apk`：可安装、同签名的正式 APK。
- `SHA256SUMS`：APK 与版本清单的 SHA-256。
- `release.json`：版本、versionCode、tag、源码提交、APK 摘要、证书指纹和内置网页版本。

先创建草稿，上传后重新下载逐项核对字节，再公开 Release。工作流构建产物也会保留在 Actions 中。
Android Release 不设为仓库全局 Latest，避免改变插件的默认下载入口。

失败后，在 GitHub Actions 的 **Android release → Run workflow** 中输入已有的
`android-v0.1.2` tag，或执行：

```sh
gh workflow run android-release.yml --ref main -f tag=android-v0.1.2
```

只能重试未完成的草稿或尚未创建 Release 的 tag。已公开版本拒绝覆盖，需要修改时发布新的版本。
不要删除或移动已公开 tag。Actions 不自动修改源码或递增版本，正式版本以 tag 对应提交为准。
手动重试使用所选工作流提交中的发布工具，应用另行检出到固定 tag；
因此可以修复发布工具后重试，保持 APK 源码不变。版本清单分别记录应用和发布工具的提交。

## 本地验证

```sh
node android-app/scripts/version.mjs --check
node --test android-app/scripts/test/*.test.mjs
actionlint .github/workflows/android.yml .github/workflows/android-release.yml
npm --prefix web-assets test
cd android-app
./gradlew --no-daemon testDebugUnitTest lintDebug assembleRelease
cd ..
node android-app/scripts/release.mjs package
```

需要 Node.js 22、JDK 17、Android SDK 及持久签名配置。打包产物位于忽略目录
`android-app/artifacts/release/`。远端下载后可在产物目录执行 `sha256sum -c SHA256SUMS`。

这套流程发布 APK；App 内现有的网页资源更新使用另一条独立验证链，不会由普通代码推送触发。
