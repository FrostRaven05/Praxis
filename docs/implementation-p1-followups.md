# T15–T31 执行记录

本轮按用户要求为每张尚未完成的工单分配独立子 agent，由主 agent 接入应用、验证公共流程并更新 ticket.md。使用 implement 技能：定向检查、最终全量验证、规范与需求两项审查、提交当前分支。T32–T34 按 2026-10-09 用户要求暂缓。

## 本地交付

- T15：任务与项目回收站、影响预览、恢复关系检查。详见 implementation-t15.md。
- T16：四类离线搜索、有限 AND/OR 筛选、保存视图和侧栏关注。详见 implementation-t16.md。
- T17：项目检查与手动周回顾、恢复卡推进证据、专用编辑器与草稿导航保护。见 implementation-t17.md。
- T18–T19：日历重复模板、离线分批补齐、稳定发生身份、未来规则和例外预览、工作空间时区原子迁移。详见 implementation-t18.md、implementation-t19.md。
- T20–T21：每日/每周习惯、完成与跳过、规则暂停恢复、历史区间和周统计。详见 implementation-t20.md、implementation-t21.md。
- T22：手机原文收集与 SQLite v2 适配已实现；主机 SQLite 验证不替代 Android 原生插件及真机验收。详见 implementation-t22.md。

桌面数据继续版本化迁移，升级前整库备份覆盖新表。当前 schema 版本从迁移列表取得，备份恢复检查与升级判断共享此来源。既有 P0 和 T08–T14 工作保持兼容。

## 实际限制

没有 Android SDK/JDK、已授权设备及相应安装路径，未生成 APK。未提供同步服务、测试账号、部署区域和安全边界。仓库没有登录或服务端同步实现，待发送队列不能视为已同步。

T23–T31 各独立工单核查记录列出代码证据和前置条件。受阻工单不勾选完成，不使用模拟服务代替真实双端验收。T30 要求的安装升级与连续试用也不能以单次本地测试替代。

## 验证记录

`scripts/native-p2.mjs` 使用独立 QA 数据库运行真实 Windows Tauri 程序，覆盖回收站、搜索与侧栏视图、重复规则、时区迁移、习惯与暂停，并强制重启检查身份与记录保持。报告保存在 docs/evidence/p2/native-p2.json。这里的 p2 是第二批流程脚本名称，不代表 P2 优先级。

最终结果：

- TypeScript 类型检查、Vite 和内嵌资源 Tauri debug 构建通过。
- 应用测试 52/52，通过真实主机 SQLite 验证的手机测试包含在内，不等于 Android 真机。
- 原生 Store 测试 86/86，包含旧数据升级/迁移失败/备份恢复、事务回滚、重试和新增规则。
- 最终桌面流程：P0 五组、T08–T14 四组、本轮八组通过；没有页面运行错误。包含强制重启和 680×600 深色窗口检查，截图见 evidence/p2/habits-dark.png。
- 两项独立审查原各 3 项发现均已修复并只读复验关闭，详见 review-p1-followups.md。最终旧流程回归另修复了保存期间后台状态控件可触发下一次确认的交互问题，并复跑相关桌面流程通过。
- 回收站默认 30 天恢复窗口可配置，删除标记与内容不因窗口到期物理清除。重复规则预览与提交共用权威判定，默认保留手动状态例外。

复现：`pnpm typecheck`、`pnpm test`；加载 scripts/native-env.ps1 后运行 `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked`。随后重新执行 `pnpm --filter @praxis/desktop exec tauri build --debug --no-bundle`，再运行 `pnpm test:p0`、`pnpm test:p1`、`pnpm test:p2`。必须在原生测试后重新构建内嵌资源，避免测试构建覆盖调试程序。Windows 受限环境中的原子备份切换、WebView2 调试及测试子进程需要相应执行权限；验证使用独立临时数据目录。
