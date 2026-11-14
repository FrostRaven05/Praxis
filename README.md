# Praxis

2026-11-10：产品定位固定为个人管理，团队协作从路线移除。同一账号跨设备同步、成长修炼与 AI 保留。当前实施以[个人版 PRD](docs/prd-mvp-v0.1.md)和[个人版开发计划](docs/mvp-development-plan-2026-11-09.md)为准；团队切片仅作[历史归档](docs/archive/team-prototype-2026-11-10/README.md)。

2026-10-25：AI 规划与自身修炼已实现首版；桌面具备关联行动、心愿奖励与设置草稿恢复，本轮继续加入项目恢复卡、近期记录、来源引用和项目内时间筛选。当前只有自身修炼，没有灵宠。范围与验证见 [项目恢复说明](docs/implementation-project-recovery.md)、[奖励闭环说明](docs/implementation-cultivation-rewards.md)、[开发进度](docs/ai-cultivation-progress.md)；DeepSeek 环境变量已接入，真实生成仍待联网验证，线上 AI 服务尚未启用。

2026-10-18：Praxis 管理后台已部署至 [线上管理控制台](https://8.152.219.210/admin)，提供数据概览、用户管理、同步数据、操作日志和系统状态，含独立管理员登录及账号禁用/设备登录撤销。公网登录、退出及原有账号同步接口验证通过，原有数据保留。运行 `pnpm admin:preview` 可本地查看；配置与验证见 [管理后台说明](docs/implementation-admin.md)。

2026-10-18：账号与同步 API 已以 Docker 部署，当前使用 `https://8.152.219.210` 的有效 IP HTTPS 证书；域名待完成备案接入后再切回。Windows 与 Android 模拟器已通过云端登录、双向任务同步及重启验证，见 [双端云连接验收](docs/implementation-ecs-clients.md)。部署与维护见 [ECS Docker 部署](docs/deploy-ecs.md)。

2026-10-11：建议任务可直接转入普通清单；Windows / Android 新增邮箱注册、登录、退出及用户数据隔离，接入现有 HTTPS 后端。新版程序与验证范围见 [用户账号与建议任务转换](docs/implementation-accounts-suggestions.md)。

2026-10-11：已建立可运行的 [局域网开发后端](docs/backend-lan.md)，Windows / Android 已接入 [非 AI 全域自动同步](docs/implementation-full-sync.md)，覆盖任务、项目、安排、记录、视图、重复和习惯等对象。实际双端验收使用 Windows WebView2 与 Android 17 模拟器；最终验收状态见该记录。手机端界面见 [手机端记录](docs/implementation-mobile-reference.md)。

T15–T21 的桌面本地能力和 T22 手机离线收集适配见 [本轮实施与验证](docs/implementation-p1-followups.md)。Android 真机、云登录、统一完整导出与发布/规模验收仍按 [当前工单](ticket.md) 推进；AI 相关 T32–T34 的首个实现切片见 [AI 首版说明](docs/implementation-ai-planner-v1.md)。Android 当前在前台及恢复前台/网络后同步，系统停止 App 期间不承诺持续后台工作。

T08–T14 已完成 Windows 本地实现：今日与近期、独立时间与工作空间时区、优先级/标签/等待、每日结果、分区和安全项目终结。见 [实施与验收记录](docs/implementation-p1-core.md)。

P0 原文收集、独立记录、澄清与安全撤销、项目下一步/恢复卡及本地备份恢复已交付。见 [P0 实施与验证](docs/implementation-p0.md) 和 [后续工单](ticket.md)。

Turn intent into action.

Ticket 01：桌面离线录入。只输入标题即可加入今天，任务、每日安排、历史事件与待同步操作在一个 SQLite 事务中保存。关闭应用后重新打开仍可读取。

桌面已支持录入、详情编辑、日期查看、改期、完成与撤销；已完成默认折叠，按实际完成日期显示。每日重点、估时、容量提醒、收件箱、项目、批量任务和项目任务加入今日已实现；本机队列在配对后自动发送至局域网后端，云同步继续按 Tickets 推进。

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
pnpm desktop:build
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

Capacitor 与原生 SQLite 已接入，调试 APK 已构建并安装至 Android 17 模拟器，已验证本机功能及局域网双端流程；物理设备验收尚未完成。当前界面及本机范围见 [手机端记录](docs/implementation-mobile-reference.md)，双端范围见 [全域同步记录](docs/implementation-full-sync.md)。[早期移动端记录](docs/implementation-02.md) 保留最初工程接入与 iOS 范围。

[桌面编辑、改期与日期查看验收](docs/implementation-desktop-edit.md)

## 直接查看桌面界面

运行 `pnpm desktop:preview`。该命令通过 Tauri 构建内置页面，并将程序复制到独立预览目录后打开，无须启动 Vite。不要直接打开经过 `cargo test` 覆盖的 target/debug 程序；它可能访问未启动的开发服务器。

[桌面项目管理验收](docs/implementation-desktop-projects.md)

桌面已支持收件箱、项目及今日的统一任务详情编辑，包括备注、完成标准、独立重要度、带时区的截止时间和预估工作量。见 [D05 验收记录](docs/implementation-desktop-task-details.md)。

D06 桌面多级子任务与叶子进度已完成；验收见 [实施记录](docs/implementation-desktop-subtasks.md)。原 13 的排序、父节点移动及跨端验收保留未完成。

桌面项目现已支持生命周期与重点筛选、同级排序和子树移动、四列看板、甘特日期与依赖编辑，以及排期影响预览和撤销。见 [D07 验收记录](docs/implementation-desktop-project-workspace.md)。

项目页已采用紧凑布局，“重点项目”现为“追踪项目”，追踪入口固定在左侧导航下。见 [D08 验收记录](docs/implementation-desktop-tracked-projects.md)。
