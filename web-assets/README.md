# Paseo 网页资源

## 独立服务器网页发布

`Managed web release` Actions 每六小时检查官方稳定版本，也支持手动指定版本。
构建模板位于 `recipes/`，固定上游提交后应用源码补丁、运行回归并生成标准网页包。
Paseo 模板保留同源 Access HTTP 下载交接，不读取正常 Paseo home。

发布标签为 `paseo-web-v<上游版本>-wb.<配方版本>`；包含压缩包、
`frontend-release.json` 和 `SHA256SUMS`。清单记录源码、配方、兼容后端及逐文件散列。
发布不移动插件 `stable`、不改变默认 Latest，也不更新 Pocket APK 或其内置网页锁。
已存在的完整版本直接跳过；构建、补丁或兼容性回归失败时不发布。

```sh
node web-assets/src/release.mjs resolve --recipe paseo --output .local/web-release/lock.json
python3 web-assets/src/build-release.py --lock .local/web-release/lock.json \
  --work .local/web-release/source --output .local/web-release/output
```

新增模板只在发布方维护来源、配方和兼容性验证。消费方通过通用 GitHub Release
来源配置选择 `paseo-web-` 标签及 `paseo-web-*.tar.gz`，不需要执行源码构建命令。

## 原有 Pocket 内置资源

```sh
npm --prefix web-assets ci --ignore-scripts
npm --prefix web-assets test
npm --prefix web-assets run bundle
```

锁定 `@getpaseo/server@0.13.0` 的 npm 签名与 SHA-512。只读取归档，不执行上游脚本。
生成的网页位于 `android-app/app/src/main/assets/paseo/`，不提交生成文件。
公钥在 `trust.json` 固定；更换公钥必须经过代码审查和 APK 升级。
包签名遵循 npm 的 `name@version:integrity` 格式，下载地址可以换成镜像。
构建缓存和网页安装目录不是 Cookie / IndexedDB 配对数据。

生成可静态托管的镜像（归档内容不变）：

```sh
node web-assets/src/mirror.mjs --version 0.13.0 --output web-assets/output/mirror \
  --public-base https://mirror.example/paseo/
```

将生成目录部署到该 HTTPS 地址，然后在 App 自定义来源中填写
`https://mirror.example/paseo/latest.json`。此命令不修改 relay 配置或发布线上资源。
