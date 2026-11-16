# Praxis 1.0.1 安装包

日期：2026-11-16。Windows 和 Android 1.0.1 已发布到[管理后台安装包页](https://todo.frostraven05.com/admin#release)，并完成实际浏览器下载校验。

## 产物

| 平台 | 文件 | 大小 | SHA-256 |
| --- | --- | --- | --- |
| Windows x64 | `Praxis-1.0.1-windows-x64-setup.exe` | 5,651,390 字节 | `b3f9eaf9787c65bc64205eedded0dad7833b86a2d9834d39edae6333e4b27f8a` |
| Android | `Praxis-1.0.1-android.apk` | 12,320,553 字节 | `ec31a1bbc1c6632506d72281ed7587cb93fa7ec048e884b75c286bb907e846b5` |

安装包、`release.json`、`SHA256SUMS.txt` 与仅含 API 源码的部署归档保存在被 Git 忽略的 `.tools/releases/1.0.1/`。没有将密钥或本机数据库打入安装包。

Windows 使用 Tauri NSIS 当前用户安装向导，提供简体中文与英文。缺少 WebView2 时由安装器下载运行时。安装器尚未做发布者代码签名，系统可能显示未知发布者提示。

Android 包名仍为 `com.praxis.mobile`，`versionCode=2`、`versionName=1.0.1`，支持 Android 7.0 起及 ARM / x86 各架构。发行构建关闭 `debuggable`。为了让已分发的旧 APK 可以保留本地数据覆盖升级，本轮沿用相同的现有开发证书；这不是 Google Play 的正式商店签名流程。私钥不进入仓库或服务器下载目录。

## 重新构建

```powershell
pnpm package:windows
```

Android 构建前设置 `JAVA_HOME`，以及 `PRAXIS_ANDROID_KEYSTORE`、`PRAXIS_ANDROID_STORE_PASSWORD`、`PRAXIS_ANDROID_KEY_ALIAS`、`PRAXIS_ANDROID_KEY_PASSWORD`，然后运行：

```powershell
pnpm package:android
```

密码只从进程环境读取。更换 Android 签名可能影响已安装版本的覆盖升级，发布前需要比较旧、新证书指纹。

## 本地验证

- Windows 静默安装到独立测试目录，核对版本、主程序和卸载器后静默卸载；跳过快捷方式且未启动应用。对比主程序时，仅归一化 Tauri 在 NSIS 包内写入的三字节安装器类型标记。
- Android `apksigner verify`、证书指纹、版本、ABI、ZIP 完整性和内置前端资源检查通过。未进行新的 Android 真机安装验收。
- 类型检查、API 构建、86 项后端测试通过，覆盖安装包下载、响应头与相邻配置文件隔离。
- 管理后台 14 项浏览器检查通过，包括两端下载链接、SHA-256 展示及 320px / 390px 布局。截图使用本地模拟发布信息，尚不代表已在线上开放下载。
- [产物验证清单](evidence/installers-1.0.1/verification.json)与[后台截图](evidence/admin/release.png)。

## 管理后台发布

后台新增“安装包”入口（`/admin#release`），读取独立管理员认证保护的 `/admin/api/release`；应用继续通过 `/app/release` 检查更新。两处使用同一份经过校验的发布信息。

两个文件已放置于服务器的 `/opt/praxis/deploy/runtime/data/releases/1.0.1/`，使用现有持久化数据卷，不新增挂载或端口。服务配置 `releaseDirectory=/data/releases`，API 只提供约定版本和文件名的 EXE / APK 下载，不开放目录列表、发布 JSON、校验文本或相邻配置文件。现有 HTTPS 域名通过 `/releases/1.0.1/` 提供下载，TLS 直通、代理和证书续期设置保持不变。

发布前已校验上传文件 SHA-256，并对数据库副本执行新镜像启动检查。切换前后 1 个账号、1 个登录会话、151 个同步实体和 44 个同步写入批次保持一致，数据库完整性检查通过。管理员凭据保持原值。完整运行数据和旧镜像回退备份为 `/opt/praxis/backups/before-admin-20261115T163151Z`，安装包发布前配置备份为 `/opt/praxis/backups/before-installers-20261115T163151Z`。

公网验收通过两个文件的匿名 HEAD 请求、管理后台真实下载与 SHA-256 比较、版本接口、管理员接口认证、相邻配置文件不可下载、390px 手机布局和退出登录。结果见[发布验证](evidence/installers-1.0.1/publication.json)，[线上桌面截图](evidence/installers-1.0.1/published-release.png)与[手机截图](evidence/installers-1.0.1/published-release-mobile.png)。
