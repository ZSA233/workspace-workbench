# Paseo Pocket 0.1.7（versionCode 8）

改善 Workbench 的多个文件保存体验，网页继续使用 Paseo 0.12。

- 系统保存位置依次选择，已选择文件可以继续写入，不再因另一个保存会话打开而报普通占用错误。
- 每个目标分别保留 URI、偏移和状态，真正写入时才打开输出流；取消只影响对应文件。
- 零字节文件也必须成功关闭后才算保存完成；页面重建释放未完成的本代保存目标。
- 与 Workbench 0.7.1 配合使用；旧插件仍可调用原来的 `WorkbenchFileSave.open(name)`。

保留原签名身份、网页资源、主机配对与应用内升级入口。APK 不会自动安装，仍由 Android 系统确认升级。

JVM、网页及发布脚本、lint 和正式构建通过。设备测试 APK 已构建；独立模拟器启动崩溃，Pocket 真机的多目标系统选择器与页面重建仍待验收。[完整验证记录](https://github.com/ZSA233/workspace-workbench/blob/android-v0.1.7/docs/verification/ux-performance-0.7.1.md)。
