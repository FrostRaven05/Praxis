# 桌面完成与撤销实施记录

## 交付

2026-09-16，按用户“先主要完善桌面端”的指示交付 D01。桌面可以完成任务、折叠已完成区和撤销；SQLite 迁移兼容已有录入数据。移动完成与双端同步未实现，原 Ticket 07 保持未完成。

状态、完成事实、领域事件和 outbox 在同一 SQLx 事务中修改。任务版本递增；撤销指定当前完成事实及预期版本，原执行事实保留 revoked_at，重复命令只返回当前状态，不重放旧修改。执行事实通过组合外键关联同一用户、任务和来源安排。

今日待办按安排日查询，已完成按有效执行事实的实际日期查询。跨日完成后显示完成日；撤销回到来源安排日，避免操作后任务不可见。详情分别显示安排日期和完成日期。

## 验证

- 类型检查、前端构建、Tauri debug 构建通过。
- TypeScript：19 项通过，包括保存结果不明确后的相同操作身份重试、完成/撤销前置条件。
- Rust/SQLite：11 项通过，包括 5 项完成行为测试：完成撤销重开、过期撤销、最后一步写入失败回滚、旧数据库升级、错配来源安排被外键拒绝。
- 原生桌面验收：10 项通过，页面错误为零。实际 Windows Tauri/WebView2 完成、默认折叠、展开、杀进程重启、撤销、跨日日期归属均通过。
- 原生测试恢复目录曾与应用自动重试创建目录产生竞态；测试改用可重复的 mkdir，最终整轮通过。
- 测试仅阻断外部 HTTP(S)，保留本地 IPC，没有更改系统网络设置；未宣称物理断网或双端同步通过。
- TDD 首条完成/撤销持久化用例因接口尚未实现失败，最小事务实现后通过；之后扩展并验证失败和升级边界。

[机器记录](evidence/desktop-completion/native-smoke.json) · [完成截图](evidence/desktop-completion/desktop-completed.png)

复现：

```powershell
pnpm typecheck
pnpm test
pnpm test:native
. .\scripts\native-env.ps1
pnpm --filter @praxis/desktop exec tauri build --debug --no-bundle
$env:PRAXIS_EVIDENCE_DIR='docs/evidence/desktop-completion'
pnpm test:desktop
```

## Standards

沿用已确认审查基准 bf7c457817544a910d16f3a75f707039016e7788，本轮增量以 9234e80 后工作区为主。

- P2：执行事实来源安排缺少组合归属约束。已加唯一键和组合外键，并测试错配拒绝。
- P2：完成/撤销前置规则只在 Rust。已补共享 TypeScript 规则，Rust 继续在事务内复核状态版本。
- P3（判断项）：借用虚假录入命令校验。已提取 UUID/时区/日期公共校验。
- 定向复核：三项全部关闭，无剩余问题。

## Spec

- P2：已完成事项按安排日期查询，跨日完成会不可见。已改按有效完成事实日期查询，并验证完成与撤销后的正确日期展示。
- P3：已完成区默认展开。已改默认折叠。
- 定向复核：两项全部关闭，无剩余问题。

统计：Standards 3 项（最严重 P2）已解决；Spec 2 项（最严重 P2）已解决。
