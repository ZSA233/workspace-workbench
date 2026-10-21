# Android 实机排查：Java 堆耗尽与语言排序路径

2026-10-21，通过 ADB 从连接的 Android 16 / API 36 测试设备采集。
本次只读取设备、宿主状态及上游源码，未安装、降级、清除数据、重启应用或修改宿主。

## 已确认的事实

- 安装包为 `sh.paseo`，`versionName=0.12.0`、`versionCode=12000`。
  Package Manager 记录最后更新时间为 **2026-10-20 00:17:50**，安装来源为
  `com.android.vending`。这些信息能确认经 Google Play 更新，不能区分自动更新与手动更新。
- Android DropBox 中提取到 **19 份属于 `sh.paseo` 的 ANR 报告**，覆盖
  10 月 15 日至 21 日。其中 **8 份来自 0.11.2，11 份来自 0.12.0**。
  因此，同类故障早于 10 月 20 日的 0.12.0 安装更新；不能简单归因于这一次更新。
- `dumpsys activity exit-info` 另记录了多次输入事件等待超过 5 秒的 ANR 和
  `APP CRASH(EXCEPTION) / JavaCrash`。没有拿到这些 JavaCrash 的明确异常名称，
  不能把每次退出都直接标成 `OutOfMemoryError`。部分退出是用户或系统清理器强停，
  也应与异常退出分开。
- 多份 ANR 的 Java 堆已逼近 **256 MB 的进程堆上限**，没有可分配空间。
  主线程和 JS 线程在等待 ART GC，形成直接的界面无响应机制。

| 时间（设备北京时间） | App 版本 | Java 堆 / 上限 | 距 OOME 的余量 | 累计 GC 时间 |
| --- | --- | --- | --- | --- |
| 10-18 21:22:50 | 0.11.2 | 255 / 256 MB | 4,048 B | 60.006 秒 |
| 10-21 10:48:02 | 0.12.0 | 256 / 256 MB | 0 B | 5.555 秒 |
| 10-21 12:30:08 | 0.12.0 | 255 / 256 MB | 24 B | 89.556 秒 |
| 10-21 12:30:47 | 0.12.0 | 255 / 256 MB | 8 B | 8.930 秒 |

GC 时间是进程运行期间的累计值，不代表一次连续暂停。Java 堆上限也不是手机总内存，
更不是 Paseo 的总 RSS；不能用手机尚有空闲内存反推应用没有堆压力。

## 重复出现的调用路径

19 份 ANR 中，**16 份**的目标进程 JS 线程包含 Hermes Intl / Android ICU 调用，
例如 `Collator.initializeCollator`、`PlatformCollatorICU.configure`、
`LocaleResolver.resolveLocale`、`Intl.getCanonicalLocales`；**11 份**的目标进程主线程
直接处于 `WaitingForGcToComplete`。

10-21 12:30:47 的 JS 线程停在：

```text
mqt_v_js: WaitingForGcToComplete
com.facebook.hermes.intl.JSObjects.newObject
com.facebook.hermes.intl.Collator.initializeCollator
com.facebook.hermes.intl.Collator.<init>
```

同一报告的主线程在 Worklets 帧回调中等待 GC；GC 线程正在标记和回收对象。其他报告
主线程位于 Fabric 挂载或滚动事件分配路径。它们说明内存压力同时阻塞了应用交互，
不能据此把 Worklets、Fabric 或某个排序调用单独判定为泄漏源。

只读对照上游 `v0.11.2` 和 `v0.12.0`，两版的以下宿主路径均调用 `localeCompare`：

- [Workspace / 项目结构排序](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/app/src/projects/workspace-structure.ts#L203)
- [侧栏状态分组排序](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/app/src/hooks/sidebar-status-view-model.ts#L75)
- [Host 项目模型排序](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/app/src/projects/host-project-model.ts#L155)

这些是与堆栈吻合的候选调用点。当前原生堆栈没有提供对应 JS 调用者，尚未证明是哪一个
调用点触发，也没有证明排序器创建本身就是长期保留对象的来源。优先验证方向是复用按
locale/options 区分的排序器、减少无关更新触发的排序，再配合分配及保留对象分析。
这应在独立测试构建中验证，不能靠插件修改全局 JavaScript 内建方法来规避。

## 插件与本次采集窗口

本机 Paseo 宿主在采集时为 0.11.0；手机 App 为 0.12.0，两者是不同组件。
Workbench 和 Usage Glance 的宿主登记状态均为 disabled。
这不能追溯证明每份历史 ANR 发生时的所有插件状态，也不能代表手机其他已配置宿主的状态。

30 秒采集窗口中，Paseo 的前后 PID 相同，没有捕获新退出或新 ANR。取得的是实际设备
保留的历史故障证据和当前运行快照，不应描述为“本轮已重现并修好”。当前 Release App
不可 `run-as`，尚未取得私有缓存、OTA 更新数据库或 Java 堆转储。

目前可以确认 **Java 堆压力 / GC 阻塞是多次卡死的直接机制**，语言排序路径是反复出现的
重点线索。不能确认 0.12.0 是否使问题更频繁、哪次提交首次引入，或 Workbench 是否曾
增加负载。现有证据不支持只靠继续调整自动恢复展示来修复全部问题，也不支持把 0.11.2
当成已验证无问题的降级目标。

## 后续温度与内存采样

用户确认，连接 USB 后的这段使用时间没有再次发生崩溃。这与本轮未捕获新 ANR / 退出
一致，但不能据此推断 USB 消除了故障。

- USB 接通且电池正在充电。HAL 当前读数中，机身 `skin` 约 **39.8～40.3°C**，
  电池约 **37.5～37.7°C**。没有把 `Cached temperatures` 中较高的旧读数当作当前温度。
  这些读数不能还原用户此前感到特别烫的峰值，也不能单独区分充电和应用负载的贡献。
- 从同一 PID 的 `/proc/<pid>/stat` 连续采样，设备 `CLK_TCK=100`，两个相邻约 2 秒
  窗口的进程 CPU 分别相当于单核 **74.0%** 和 **9.5%**。这是短时波动，不能说明
  Paseo 一直高负载，也不能用 `dumpsys cpuinfo` 的较早统计窗口替代当前 CPU。
- 最新 `dumpsys meminfo` 的 Dalvik Heap 已分配 **21,550 KiB（约 21 MiB）**，
  没有处于历史故障时 Java 堆接近 256 MB 的状态。原生堆已分配约 **519 MiB**，
  整个进程 RSS 约 **946 MiB**。原生堆、图像、图形等内存不受这个 Java 堆指标完整描述，
  不能拿整个进程 RSS 与 256 MB 直接比较。
- 同一进程的原生分配和 View 数量较早期快照增加，但采样之间用户操作和页面不同，
  不能仅凭增长就认定泄漏；需要在固定操作中验证是否回落，并定位保留对象及分配来源。

模型计算在服务端进行，客户端仍承担消息解析、页面布局、文本和图片显示等工作。
若反复创建对象或仍保留本应释放的对象，可能产生密集 GC 或逼近 Java 堆上限；
分配压力、GC 与反复渲染也可能增加 CPU 开销。目前已确认历史故障中的 GC 阻塞，
没有确认本次发热与该机制同源，也没有取得足以确定泄漏源的堆转储。
参见 Android 官方的[内存管理说明](https://developer.android.com/topic/performance/memory-overview)
和[温度状态说明](https://developer.android.com/games/optimize/adpf/thermal)。

## 本地证据

原始采集保存在本机私有临时目录。该目录不随仓库分发；报告不包含设备序列号、
用户主机名、连接地址或本机目录标识。

主要文件：`app-package.txt`、`exit-info-initial.txt`、`report.json`、
`anr-thread-summary.json`、`anr-heap-summary.json`、`latest-paseo-process-stack.txt`、
`paseo-anr-records.txt`、`followup-summary.json`、`followup-thermal.txt`、
`followup-memory.txt`。原始日志与截图保留在私有目录，不加入版本库或发送到上游。
