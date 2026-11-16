# Praxis 1.0.3 发布

日期：2026-11-17。此版本包含当前任务、子任务、跨日结转、番茄环境音、界面和安装包分发改动；新增旧排程接口的未完成子任务检查，防止汇总父任务被错误排入今日。

| 平台 | 本地安装包 | 字节 | SHA-256 |
| --- | --- | --- | --- |
| Windows x64 | `.tools/releases/1.0.3/Praxis-1.0.3-windows-x64-setup.exe` | 26,905,587 | `f59d0ea889bfc3632632df5b4c3a83552661d959550e1fe52b6d93d2faab02c8` |
| Android | `.tools/releases/1.0.3/Praxis-1.0.3-android.apk` | 33,517,362 | `cf823ae3d1ae7e485b3cddc60e39aff5a8442806bd9af9efe25a0b017b8ba84d` |

应用标识仍为 `com.praxis.desktop` 和 `com.praxis.mobile`。Android `versionCode=4`，发行包不可调试；证书 SHA-256 仍为 `d3cbcc6d98364ff17ed206963afcd3374ca0031f752dc8d85494d665a42f85f7`，支持旧版保留数据覆盖升级。Windows 仍使用现有 NSIS 向导，未做发布者代码签名。包体增加来自九种内置环境音，来源及授权说明随资源分发。

## 验证

- 类型检查、339 项 TypeScript 测试、189 项 Rust 库与集成测试、14 项本地管理后台浏览器检查通过。
- 原生测试发现旧 `schedule_task` 接口遗漏未完成子任务检查。现有子任务回归测试稳定复现后，补齐检查，并验证拒绝操作不创建今日安排、不改变任务版本；完整 Rust 测试重跑通过。
- Windows 使用 1.0.2 分发程序与 1.0.3 分发程序的副本验证旧账号会话、账号任务和访客任务保留、重新登录与同步。副本仅等长替换内嵌应用标识以隔离本地数据。由于已有用户安装，本轮没有运行安装向导覆盖它；保留上轮的安装器验收记录。
- 九种环境音均能在真实 Windows WebView 中加载音频元数据。Android APK ZIP 完整性、内置前端资源和九个音频文件与构建输入一致，未包含数据库或私钥。
- Android 在项目专用 `Praxis_P4` 模拟器上直接用实际签名 APK 从 1.0.2 覆盖升级至 1.0.3。登录、任务保留和双向同步使用独立本地 HTTPS 后端验收，不写入生产测试账号。
- 两端默认后端仍为 `https://todo.frostraven05.com`。未替换原桌面数据库，未迁移既有 IP 地址账号的工作区或待同步数据。

## 发布

本地安装包、`release.json`、`SHA256SUMS.txt`、源码摘要和仅含 API 源码的部署归档位于被 Git 忽略的 `.tools/releases/1.0.3/`。源码提交为 `c60f5e9dc5d6a9f39e3208987a6b1f66e5bfb860`。

香港时间 2026-11-17 01:11 已按现有流程重建并部署 API，先通过数据库副本迁移和 HTTPS 启动检查，再切换服务。API 源码对应的构建复用了缓存，镜像摘要与前版相同；本轮后端版本信息和安装包分发更新为 1.0.3，服务健康检查通过。

发布前后全部数据库表记录数一致，包括 1 个账号、2 个账号会话、296 个同步实体、385 个实体版本和 86 个同步变更批次；账号身份摘要和数据库完整性检查通过。Compose、Nginx 和管理员配置保留。后端与运行数据备份为 `/opt/praxis/backups/before-admin-20261116T171120Z`，发布配置和数据库副本备份为 `/opt/praxis/backups/before-installers-20261116T171119Z`。

详见[部署记录](evidence/installers-1.0.3/deployment.json)、[本地验证](evidence/installers-1.0.3/verification.json)、[Windows 数据升级](evidence/installers-1.0.3/windows-verify.json)、[Android 升级](evidence/installers-1.0.3/android-verify.json)和[双向同步](evidence/installers-1.0.3/windows-sync.json)。

公网验收已完成：版本接口和管理后台均显示 1.0.3，两份安装包通过浏览器实际下载并核对字节数及 SHA-256，原 1.0.2 下载仍可用。管理员接口认证、相邻配置不可下载、390px 手机布局和浏览器脚本错误检查通过。见[公网下载验证](evidence/installers-1.0.3/publication.json)、[桌面截图](evidence/installers-1.0.3/published-release.png)和[手机截图](evidence/installers-1.0.3/published-release-mobile.png)。

下载：[Windows 1.0.3](https://todo.frostraven05.com/releases/1.0.3/Praxis-1.0.3-windows-x64-setup.exe)、[Android 1.0.3](https://todo.frostraven05.com/releases/1.0.3/Praxis-1.0.3-android.apk)。
