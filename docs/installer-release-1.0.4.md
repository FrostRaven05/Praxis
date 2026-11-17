# Praxis 1.0.4 发布

日期：2026-11-17。发布源码快照为 `eb61c35a64f5c3a461cdc10855796abeed38eb29`，包含关闭注册、账号与操作反馈、受限重试恢复、每日安排和习惯拖拽，以及 12 类 48 条环境音。后续开发修改不混入本轮隔离构建。

| 平台 | 安装包 | 字节 | SHA-256 |
| --- | --- | --- | --- |
| Windows x64 | `.tools/releases/1.0.4/Praxis-1.0.4-windows-x64-setup.exe` | 172,497,281 | `9de186ed9efecdf8ad9080b5c4225715843579788cac6e2881b0d12c7455b45a` |
| Android | `.tools/releases/1.0.4/Praxis-1.0.4-android.apk` | 179,716,598 | `7bca4e985466677ab035239ec574db88ce3eb94e8d3a2d2df337a4c7d5cd174a` |

保留 `com.praxis.desktop`、`com.praxis.mobile` 和既有 Android 签名，Android `versionCode=5`、非调试发行构建。Windows 仍使用既有 NSIS 向导，未做发布者代码签名。音轨约 146 MB，包内保留来源清单、字节数和哈希。

## 数据升级兼容

隔离验收发现旧安装包的部分 SQL 迁移含 CRLF，而 Git 导出的源码为 LF，SQLx 因原始字节校验差异拒绝打开健康数据库。兼容层仅识别 LF、CRLF，以及 7 个从已交付旧数据库验证的混合换行摘要；混合版本还必须匹配当前规范化 SQL 摘要。其他迁移内容或校验和变化仍被拒绝。

兼容处理在内存中选择校验摘要，不改写 `_sqlx_migrations`，不替换数据库，不清除待同步数据。原有完整性检查继续先于迁移运行。兼容记录位于 `src/store/legacy_line_endings.json`，SQL 迁移目录保持只包含迁移脚本。

## 验证

- 固定快照通过类型检查、378 项 TypeScript 测试、193 项 Rust 库及集成测试。
- 新增 4 项迁移回归，覆盖 LF/CRLF、已交付混合换行、待同步内容与迁移记录保留，以及拒绝真正的迁移修改。
- Windows 发行程序副本从 1.0.3 数据升级，验证账号会话、访客任务、账号任务、重新登录和同步。副本只替换内嵌应用标识以隔离数据；已有用户安装未被覆盖。
- 最终实际签名 Android APK 覆盖安装后保留旧账号和任务；注销后确认登录页不提供注册操作。
- 本地隔离 HTTPS 后端的双向同步通过，未在生产创建业务测试账号。
- 48 条音轨的字节数、哈希和浏览器解码通过；桌面与手机的类别、音轨切换、记忆、循环、停止和异常恢复通过。真实 Windows WebView 可加载全部 48 条音轨。
- 操作反馈浏览器场景 9 项检查、独立管理后台 14 项检查通过。
- 隔离依赖的本机文件权限问题通过使用已有同版本 esbuild 可执行路径处理，依赖 JS 已恢复原状；复核前端逐文件摘要完全一致。详见[构建记录](evidence/installers-1.0.4/build-workaround.json)。

## 部署和下载

发布使用既有数据库备份、隔离副本预检和失败回退流程。生产注册关闭会在候选镜像的可丢弃数据库副本上验证。安装包上传及发布目录执行完整 SHA-256 校验；公网检查响应头、浏览器下载文件名及前 64 KiB 与本地一致性。

已部署到 `https://todo.frostraven05.com`，API 容器健康检查通过，版本接口返回 `1.0.4`。候选镜像通过数据库副本迁移、HTTPS 启动和注册关闭预检；正式部署后数据库完整性为 `ok`，全部表计数一致，既有账号身份和密码摘要保持一致。关键计数为账号 1、会话 2、同步实体 355、同步变更 104。Compose 和 Nginx 配置摘要保持不变，旧 1.0.3 安装包仍可下载。

发布前备份为 `/opt/praxis/backups/before-installers-20261117T152750Z`；后端切换备份为 `/opt/praxis/backups/before-admin-20261117T152758Z`。公网验证于 `2026-11-17T15:37:32.618Z` 完成：两端响应长度、下载文件名、前 64 KiB 与本地一致，完整 SHA-256 在服务器落盘后验证。后台桌面和 390px 手机布局通过，浏览器错误为零；相邻配置及清单文件不对外提供。

- [Windows x64 安装包](https://todo.frostraven05.com/releases/1.0.4/Praxis-1.0.4-windows-x64-setup.exe)
- [Android APK](https://todo.frostraven05.com/releases/1.0.4/Praxis-1.0.4-android.apk)

证据见[验证清单](evidence/installers-1.0.4/verification.json)、[服务器部署](evidence/installers-1.0.4/deployment.json)、[公网下载验收](evidence/installers-1.0.4/publication.json)、[Windows 最终启动](evidence/installers-1.0.4/windows-final.json)、[Android 验收](evidence/installers-1.0.4/android-verify.json)和[迁移历史摘要](evidence/installers-1.0.4/verified-legacy-checksums.json)。
