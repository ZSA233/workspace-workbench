# Paseo 网页资源

```sh
npm --prefix web-assets ci
npm --prefix web-assets test
npm --prefix web-assets run bundle
```

锁定 `@getpaseo/server@0.12.0` 的 npm 签名与 SHA-512。只读取归档，不执行上游脚本。
生成的网页位于 `android-app/app/src/main/assets/paseo/`，不提交生成文件。
公钥在 `trust.json` 固定；更换公钥必须经过代码审查和 APK 升级。
包签名遵循 npm 的 `name@version:integrity` 格式，下载地址可以换成镜像。
构建缓存和网页安装目录不是 Cookie / IndexedDB 配对数据。
