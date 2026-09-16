# Ticket 01 实施记录

## 状态

进行中：工程准备已完成，业务实现尚未开始。

用户已发出开始实现指示，32 张 Tickets 从草稿发布到本地 issues 目录。初始文档提交为 bf7c457817544a910d16f3a75f707039016e7788，已提议用作本轮代码审查基准，等待用户确认。

## 已完成

- pnpm workspace、严格 TypeScript、React/Vite 前端工程及最小今日页面。
- Tauri 桌面启动入口、窗口配置、CSP、图标与原生构建配置。
- 前端及 Rust 依赖锁定；项目内隔离 Rust 工具链，不修改系统 PATH。
- Windows 构建环境脚本，复用现有 MSVC/Windows SDK。
- 当前 Ticket 状态更新为 in-progress，其余 Tickets 不提前认定完成。

## 实际验证

| 检查 | 结果 |
|---|---|
| pnpm typecheck | 通过 |
| pnpm build | 通过；Vite 产物已生成 |
| pnpm peers check | 通过；没有 peer dependency 问题 |
| cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml | 通过；需先载入 native-env.ps1 |
| 桌面启动与真实交互 | 尚未执行 |
| 录入、持久化、事务回滚、重启恢复 | 尚未实现或验证 |
| TDD 业务测试与完整测试套件 | 尚未编写或运行 |
| 双轴代码审查 | 业务完成且基准确认后执行 |

## 待确认的 TDD 测试边界

1. 录入用例：仅标题录入、空标题拒绝、保存错误可见。
2. 日期归属：用户时区中的今天，跨午夜与不同 UTC 日期。
3. 原子存储与恢复：Task、当日安排、历史和 outbox 一起提交或回滚；关闭后重开可读取。

implement 要求在已约定边界尽可能用 TDD。指定的 TDD 技能明确要求先确认边界，已通过异步问题请求确认，当前未收到答复，未编写测试也未假称已完成红绿循环。

## 下一步

收到边界与审查基准确认后，逐个行为执行失败测试 → 最小实现 → 验证；接通共享用例、Rust SQLite 事务和真实录入 UI。完成后按 implement 调用 Standards / Spec 两轴审查，修复问题并提交。

本机 Git 初始目录由沙箱账号创建，普通用户运行 Git 时需要对当前命令指定 safe.directory；没有改动全局 Git 信任配置。沙箱初始化刷新错误后，工程命令通过自动审核的普通工作目录执行。
