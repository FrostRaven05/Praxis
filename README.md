# Praxis

T15–T21 的桌面本地能力和 T22 手机离线收集适配见 [本轮实施与验证](docs/implementation-p1-followups.md)。Android 真机、同步、完整导出与发布验收仍按 [当前工单](ticket.md) 的依赖推进；AI 相关 T32–T34 暂缓。

T08–T14 已完成 Windows 本地实现：今日与近期、独立时间与工作空间时区、优先级/标签/等待、每日结果、分区和安全项目终结。见 [实施与验收记录](docs/implementation-p1-core.md)。

P0 原文收集、独立记录、澄清与安全撤销、项目下一步/恢复卡及本地备份恢复已交付。见 [P0 实施与验证](docs/implementation-p0.md) 和 [后续工单](ticket.md)。

Turn intent into action.

Ticket 01：桌面离线录入。只输入标题即可加入今天，任务、每日安排、历史事件与待同步操作在一个 SQLite 事务中保存。关闭应用后重新打开仍可读取。

桌面已支持录入、详情编辑、日期查看、改期、完成与撤销；已完成默认折叠，按实际完成日期显示。已支持每日重点排序、估时、容量提醒及收件箱；已支持项目基本信息、批量任务、临时任务归属和项目任务加入今日；完整项目功能及云同步继续按 Tickets 实现；outbox 仅保存在本机。

## 文档与任务

- [产品需求](Spec.md)
- [技术路线](TECHNOLOGY.md)
- [本地 Tickets](.scratch/praxis-mvp/README.md)
- [当前桌面切片](.scratch/praxis-mvp/issues/D05-desktop-task-details.md)
- [桌面优先实施顺序](docs/desktop-first.md)
- [完成与撤销验证记录](docs/implementation-desktop-completion.md)
- [实施与验证记录](docs/implementation-01.md)

## Windows 桌面开发

需要 Node.js 22.15 或兼容版本、packageManager 指定的 pnpm、Rust MSVC 工具链、Visual C++ 构建工具、Windows SDK 和 WebView2。

```powershell
pnpm install --frozen-lockfile
. .\scripts\native-env.ps1
pnpm desktop
```

本工作区已有隔离 Rust 安装，native-env.ps1 会优先载入；不修改系统 PATH。新设备需先安装自己的 Rust/MSVC 环境。

构建自带前端资源的调试程序：

```powershell
. .\scripts\native-env.ps1
pnpm --filter @praxis/desktop exec tauri build --debug --no-bundle
```

产物为桌面工程 target/debug/praxis-desktop.exe。当前不生成签名安装包。

正常运行的数据存放在 Tauri 应用数据目录 com.praxis.desktop 下的 praxis.db。只有调试构建允许 PRAXIS_DATA_DIR 覆盖目录，自动验证使用此机制隔离样本。

## 验证

```powershell
pnpm typecheck
pnpm build
pnpm test
pnpm test:native
pnpm test:desktop
```

test:desktop 要先构建上述调试程序。它启动真实 Tauri/WebView2，验证录入及进程强制结束后的恢复，只终止自己创建的测试进程；测试记录和截图写入 docs/evidence/ticket-01。外部 HTTP(S) 被测试拦截，系统网络设置不变。

`pnpm dev` 可以查看浏览器预览；预览明确禁用保存，不用浏览器存储冒充 SQLite。

## 结构

- 共享应用包：录入用例、日期规则和存储接口。
- React 客户端：今日清单、录入与错误反馈。
- Tauri Rust：窄 IPC 命令、参数校验、SQLite 迁移与原子事务。
- 本地任务系统：逐条依赖与验收，未实现的功能不提前标记完成。

## Android 开发进度

Ticket 02 已加入 Capacitor 工程与原生 SQLite 适配，尚未完成 APK 构建和真机验收。构建依赖、命令、测试结果及 iOS 范围见 [移动端实施记录](docs/implementation-02.md)。

[桌面编辑、改期与日期查看验收](docs/implementation-desktop-edit.md)

## 直接查看桌面界面

运行 `pnpm desktop:preview`。该命令通过 Tauri 构建内置页面，并将程序复制到独立预览目录后打开，无须启动 Vite。不要直接打开经过 `cargo test` 覆盖的 target/debug 程序；它可能访问未启动的开发服务器。

[桌面项目管理验收](docs/implementation-desktop-projects.md)

桌面已支持收件箱、项目及今日的统一任务详情编辑，包括备注、完成标准、独立重要度、带时区的截止时间和预估工作量。见 [D05 验收记录](docs/implementation-desktop-task-details.md)。

D06 桌面多级子任务与叶子进度已完成；验收见 [实施记录](docs/implementation-desktop-subtasks.md)。原 13 的排序、父节点移动及跨端验收保留未完成。

桌面项目现已支持生命周期与重点筛选、同级排序和子树移动、四列看板、甘特日期与依赖编辑，以及排期影响预览和撤销。见 [D07 验收记录](docs/implementation-desktop-project-workspace.md)。

项目页已采用紧凑布局，“重点项目”现为“追踪项目”，追踪入口固定在左侧导航下。见 [D08 验收记录](docs/implementation-desktop-tracked-projects.md)。
