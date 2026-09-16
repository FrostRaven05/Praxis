# Praxis

Turn intent into action.

当前实现阶段：Ticket 01 的工程准备。已有 React 今日页面、Tauri 桌面启动入口和项目构建配置；尚未实现任务录入、SQLite 持久化或同步。不可当作可用任务管理版本。

## 文档与任务

- [产品需求](Spec.md)
- [技术路线](TECHNOLOGY.md)
- [本地 Tickets](.scratch/praxis-mvp/README.md)
- [当前 Ticket](.scratch/praxis-mvp/issues/01-desktop-offline-capture.md)
- [实施记录](docs/implementation-01.md)

## 前端

使用 Node.js 22.15 或兼容版本，以及 packageManager 声明的 pnpm。

```powershell
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm build
```

浏览器入口目前仅用于查看页面；没有模拟保存或冒充 SQLite 的浏览器存储。

## Windows 桌面

需要 Rust MSVC 工具链、Visual C++ 构建工具、Windows SDK 和 WebView2。若本机没有 Rust，可依据 Rust 官方说明安装；不要将项目内的本机工具缓存提交到仓库。

本工作区已安装项目内隔离 Rust，可在同一个 PowerShell 会话中初始化构建环境：

```powershell
. .\scripts\native-env.ps1
pnpm desktop
```

仅检查 Rust 编译：

```powershell
. .\scripts\native-env.ps1
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
```

本轮运行过前端类型检查、生产构建和 Rust 编译检查。尚未运行桌面应用交互验收或业务测试。详见实施记录。

## 范围

首个切片将使用户只输入标题就能保存今日临时任务，并通过同一个 SQLite 事务保留 Task、DailyPlanItem、历史与 outbox。后续任务按依赖逐项实现；没有提前接通云端或将 UI 空壳当作完成首版。
