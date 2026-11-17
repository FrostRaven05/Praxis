# Praxis

Turn intent into action.

Praxis 是面向个人的任务与项目管理应用，包含 Windows 桌面端、Android 手机端和账号同步服务。任务、项目、今日安排与收件箱围绕同一份个人数据组织，同一账号可跨设备同步。

## 当前功能

- 个人任务、项目、收件箱、今日安排与多级子任务。
- 项目列表、看板、日历与甘特视图，支持备注、截止时间和任务排序。
- 番茄钟、记录与回顾，以及本地备份恢复。
- 邮箱账号、密码修改、设备登录管理与个人数据隔离。
- AI 规划助手与模型配置。
- 独立管理后台：数据概览、用户管理、同步数据、模型设置和系统状态。删除用户需输入邮箱确认。

产品范围以[个人版需求](docs/prd-mvp-v0.1.md)和[领域说明](CONTEXT.md)为准；历史团队协作原型与早期界面记录保留在文档归档中。

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `apps/client` | React / TypeScript 共享界面 |
| `apps/desktop` | Tauri / Rust Windows 桌面端与本地 SQLite |
| `apps/mobile` | Capacitor Android 原生工程 |
| `apps/api` | Fastify 账号、同步、AI 服务及管理后台 |
| `packages/application` | 共享领域规则与应用用例 |
| `packages/storage-mobile` | 手机端 SQLite 存储与同步适配 |
| `scripts` | 开发、构建及验收脚本 |
| `deploy` | Docker 与服务部署脚本 |
| `docs` | 需求、开发计划、实施记录及验证证据 |

## 本地开发

需要 Node.js 22.15 或兼容的新版本，以及 `package.json` 中指定的 pnpm。Windows 桌面端还需要 Rust MSVC、Visual C++ 构建工具、Windows SDK 和 WebView2；Android 需要 Android Studio、SDK 和对应 Java 环境。

安装依赖并启动浏览器界面预览：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

浏览器预览用于界面检查；持久化和原生能力请使用桌面或手机应用验证。

启动 Windows 桌面端：

```powershell
. .\scripts\native-env.ps1
pnpm desktop
```

构建桌面端使用 `pnpm desktop:build`；直接预览内置页面使用 `pnpm desktop:preview`。`native-env.ps1` 可优先使用本地隔离工具链，新设备需自行安装开发环境。

生成 Windows 安装向导使用 `pnpm package:windows`；配置 Android 签名环境后使用 `pnpm package:android`。产物与发布流程见[安装包说明](docs/installer-release-1.0.4.md)。

Android 构建、原生存储及双端验证见[手机端说明](docs/implementation-mobile-reference.md)与[全域同步说明](docs/implementation-full-sync.md)。

## 管理后台与服务

使用本机独立数据库预览管理后台：

```powershell
$env:PRAXIS_ADMIN_TOKEN = Read-Host "输入至少 32 个字符的临时管理密钥"
pnpm admin:preview
```

访问 `http://127.0.0.1:4319/admin`。本地预览不连接生产数据库。API 配置、HTTPS、模型服务和部署步骤见[管理后台说明](docs/implementation-admin.md)与[部署说明](docs/deploy-ecs.md)。

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @praxis/api build
pnpm test:native
pnpm test:admin
```

`test:native` 需要 Windows 原生工具链；`test:admin` 使用隔离的临时数据库和本机浏览器。原生桌面交互测试需先构建程序，使用 `pnpm test:desktop`。Android 真机、签名和发布验收不能由浏览器测试代替。

## 文档与本地文件

从[文档索引](docs/README.md)查找需求、当前开发计划、实施和验收记录。旧版首页已保存在[开发历史](docs/archive/readme-before-github-2026-11-15.md)。

源码、锁文件、正式文档和验证记录纳入版本控制；本地工具、临时预览、构建产物、数据库、密钥和签名文件由 `.gitignore` 排除。已有 Markdown 工单继续保留在 `.scratch/praxis-mvp`；其他 `.scratch` 内容仅用于本地开发。
