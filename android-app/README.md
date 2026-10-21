# Paseo Pocket Android

独立 Android 子项目，包名 `dev.paseo.pocket`，最低 Android 8（API 26）。
构建工具锁定在 `gradle/libs.versions.toml` 与 Wrapper 配置中；使用 JDK 17。

```sh
cd android-app
./gradlew testDebugUnitTest lintDebug assembleDebug
node scripts/create-signing-key.mjs
./gradlew assembleRelease
```

签名密钥默认保存到 `~/.config/paseo-pocket/`，不会进入 Git。
请安全备份整个目录。后续覆盖安装必须使用同一密钥；不要重新生成。
也可用 `WORKBENCH_SIGNING_PROPERTIES` 指向包含 `storeFile`、`storePassword`、
`keyAlias`、`keyPassword` 的私有 properties 文件。

此工程不修改 Paseo 宿主、relay 或已安装插件。
