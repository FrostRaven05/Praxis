# Praxis 1.0.2 安装包

日期：2026-11-16。两端安装包已重新构建并通过隔离安装、覆盖升级和双向同步验收。用户明确授权读取既有部署凭据后，1.0.2 已发布至线上版本接口和管理后台安装包页。

| 平台 | 本地产物 | 大小 | SHA-256 |
| --- | --- | --- | --- |
| Windows x64 | `.tools/releases/1.0.2/Praxis-1.0.2-windows-x64-setup.exe` | 5,650,800 字节 | `e86c6862e6ffd182d958912a52441410e6da85af570cac9fb37bf4274511ee0b` |
| Android | `.tools/releases/1.0.2/Praxis-1.0.2-android.apk` | 12,321,021 字节 | `bfcbc9dbe0a65883427fcfd6a6d014c5f634f23aa535c77e391a11d4a3181c2b` |

本轮包含开始打包时的未提交客户端与任务处理改动。应用源码在构建后保持一致，262 个原生应用相关文件与内置前端资源的摘要保存在安装包目录的 `source-manifest.json`。其他任务后来新增的独立宣传页及其 Vite 输出不属于本轮快照。没有回退、覆盖或提交其他开发工作。

Windows 仍使用 `com.praxis.desktop`、NSIS 当前用户安装模式，发行版本为 1.0.2。安装器仍未做发布者代码签名。Android 仍使用 `com.praxis.mobile`，版本为 1.0.2，`versionCode=3`，非调试发行构建，支持 Android 7.0 起和四种 ABI。签名证书 SHA-256 与 1.0.1 完全一致：`d3cbcc6d98364ff17ed206963afcd3374ca0031f752dc8d85494d665a42f85f7`。沿用现有开发证书是为了保留旧 APK 覆盖升级能力。

## 验证

- 类型检查、339 项 TypeScript 测试和 28 项 Rust 库测试通过。
- Windows 实际安装 1.0.1 后覆盖升级至 1.0.2，安装注册版本和主程序内容核对通过，并完成静默卸载。
- Windows 发行版忽略调试数据目录变量。运行验收因此使用安装后主程序的副本，只等长替换内嵌应用标识以选择独立数据目录；分发程序标识未修改。测试验证原账号会话、账号任务、访客任务、退出和重新登录均保留。
- Android 在项目专用 `Praxis_P4` 模拟器上直接安装实际签名发行 APK，以同包名覆盖升级；旧登录和任务保留。新包签名、ZIP 完整性、版本码、非调试标记和内置前端输入一致性通过。
- 使用本地隔离 HTTPS 后端完成两端登录和双向同步：Windows 新建任务在 Android 显示，Android 完成旧任务后 Windows 原生存储收到完成状态。测试结束后停止测试服务和模拟器。
- 两端全新账号服务默认值仍为 `https://todo.frostraven05.com`；本轮未替换原桌面数据库，也未迁移既有 IP 地址账号的工作区或待同步数据。

完整记录见 [验证清单](evidence/installers-1.0.2/verification.json)、[Windows 安装](evidence/installers-1.0.2/windows-installer.json)、[Windows 升级](evidence/installers-1.0.2/windows-verify.json)、[Android 升级](evidence/installers-1.0.2/android-upgrade.json)、[Android 数据与同步](evidence/installers-1.0.2/android-verify.json)和[跨端回传](evidence/installers-1.0.2/windows-sync.json)。

## 发布状态

发布清单与 `SHA256SUMS.txt` 保存在 `.tools/releases/1.0.2/`。本次发布只新增 1.0.2 文件和更新服务器版本信息，保留原 1.0.1 文件、后端镜像、Compose、Nginx 和管理员配置；修改前已备份配置与数据库。

用户已明确授权从本机保存的原部署聊天读取既有 ECS SSH 密码并发布 1.0.2。凭据仅在进程内存使用。发布于香港时间 2026-11-16 23:40 完成，备份位于 `/opt/praxis/backups/before-installers-20261116T154021Z`。

切换前后各表记录数完全一致，包括 1 个现有账号、2 个账号会话、278 个同步实体和 79 个同步变更批次，数据库完整性检查通过。后端镜像、Compose、Nginx 与其余服务配置保持不变，API 重启后恢复健康。详见[部署与数据库验证](evidence/installers-1.0.2/deployment.json)。

生产业务写入测试仍未执行；此前被自动审批拒绝后，登录和同步兼容性已改为本地隔离验证。本次发布的线上验收仅检查版本接口、安装包下载和后台分发页面。

公网版本接口已返回 1.0.2，管理后台显示两端新下载地址。通过真实浏览器下载 Windows 和 Android 文件后，大小及 SHA-256 均与本地产物一致；旧版下载仍可用。管理员接口认证保护、相邻配置文件不可下载及 390px 手机布局通过，无浏览器脚本错误。详见[公网发布验证](evidence/installers-1.0.2/publication.json)、[桌面截图](evidence/installers-1.0.2/published-release.png)和[手机截图](evidence/installers-1.0.2/published-release-mobile.png)。

直接下载：[Windows 1.0.2](https://todo.frostraven05.com/releases/1.0.2/Praxis-1.0.2-windows-x64-setup.exe)、[Android 1.0.2](https://todo.frostraven05.com/releases/1.0.2/Praxis-1.0.2-android.apk)。
