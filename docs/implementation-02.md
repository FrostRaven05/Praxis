# Ticket 02 实施记录

## 状态

2026-09-16：实现与宿主验证已提交，Ticket 保持 in-progress。Android APK 尚未构建，真机验收尚未执行；不得将以下宿主结果视作移动端验收。

## 实现

- Capacitor 8.5.2 + SQLite 插件 8.1.1，Android 工程位于 apps/mobile/android。
- React 复用 CaptureToday。按运行环境选择 Tauri 或 Capacitor 存储；浏览器不启用替代存储。
- 移动适配串行使用同一个连接，任务、每日安排、历史、outbox 在显式原生事务中提交；失败回滚，原操作重放去重。
- 复用桌面初始 DDL，但按插件要求逐条注册迁移；外键与 FULL 同步单独设置，WAL 通过 query 设置。
- 返回前台刷新本地日期与查询；窄屏常驻录入、安全区内边距、44px 点击目标、16px 输入字体、adjustResize 软键盘布局。
- Android 禁用系统自动备份，避免恢复另一设备的本机身份；后续账号同步另行实现。
- 诊断仅记录阶段、操作 UUID、错误类别和可提取数字码，不记录任务正文、路径或原始 SQL 错误。

## 已执行验证

- pnpm typecheck、pnpm build：通过。
- pnpm test：17 项通过，含 6 项移动适配器宿主 SQLite 测试。
- pnpm test:native：6 项 Rust/SQLite 测试通过。
- 桌面原生构建及 7 项 UI 验收通过，共享页面改动未破坏 Ticket 01。
- cap add android / cap sync android：通过，识别 App 与 SQLite 两个原生插件。
- 两种适配器读取同一份 packages/application/fixtures/capture-storage.json，验证首次提交、重复命令、身份复用、计划冲突回滚及修正重试。
- 移动适配测试真实打开磁盘 SQLite，按与原生相同的语句数组逐句建表。驱动是宿主 Node SQLite，不是 Android SQLCipher；原生桥尚未验证。
- TDD：事务开始失败的提示用例先失败（泄露原始错误），扩大错误边界后通过。
- Android Gradle 实际尝试失败：JAVA_HOME 未设置，PATH 中找不到 java。常用路径中未发现 Android SDK、adb 或 Android Studio。

## Android 构建与待验收步骤

原生工程使用 Java 21、compileSdk/targetSdk 36、minSdk 24。配置本机 JDK 与 Android SDK 后：

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @praxis/mobile exec cap sync android
Push-Location apps/mobile/android
.\gradlew.bat assembleDebug
Pop-Location
adb devices
adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

尚未产生 APK。连接已授权 USB 调试的 Android 真机后记录型号、Android/WebView 版本和以下实际结果：

1. 初次启动、中文输入法录入、只填标题保存、空标题提示。
2. 断网保存，切到后台再返回，列表和日期刷新。
3. 强制停止 com.praxis.mobile 后重开，原任务、历史与 outbox 保留。
4. 窄屏长清单、软键盘打开/关闭、系统返回、安全区、详情滚动可用。
5. 真机存储事务异常后无半份数据，同一命令重试不重复。
6. 记录屏幕证据与日志；只记录测试任务，不采集用户既有数据。

## iOS 范围

iOS 尚未生成原生工程、构建、签名或测试。需要 macOS、Xcode 26 或更高、Xcode 命令行工具及真机签名资源；当前 Windows 环境不能完成本地 iOS 构建。后续在该环境运行 cap add ios，再验证 SQLite 插件依赖、签名和相同生命周期场景。[Capacitor 官方环境要求](https://capacitorjs.com/docs/getting-started/environment-setup)

## Standards

初审基于 9263d6f 至本轮工作区：

- P1：整段迁移被当作单条 SQL；已改逐句注册，测试复用语句数组。
- P1：返回结果的 WAL PRAGMA 走 execute；已改 query，其余 PRAGMA 独立执行。
- P2：诊断缺少错误类别，读取和事务开始失败未完整覆盖；已加入脱敏诊断与完整保存边界错误处理，增加失败重试回归。
- 原生 API 行为核对已安装插件源码及 [SQLite 插件项目](https://github.com/capacitor-community/sqlite)。

## Spec

- P1：原生迁移与 PRAGMA 执行方式不满足离线存储初始化要求；已修复并通过定向复核。
- 实际 Android 验收仍未执行，Ticket 不标记 done。

审查统计：Standards 发现 3 项（最严重 P1），修复 3 项；Spec 发现 1 项（P1），修复 1 项。原生环境验收仍待完成。
