# D02 桌面编辑与改期

## 交付行为

2026-09-16 完成。详情可编辑标题和安排日期，主列表可选择日期并回到今天；改期后自动显示目标日。录入框仍明确标为“添加至今日”，查看其他日期不改变录入归属。

保存标题、安排日期、历史及 outbox 使用同一 SQLx 事务。安排 ID 保持稳定，任务版本递增，过期编辑不会覆盖新数据。重试沿用未确认的操作身份，已提交命令不会重复执行。

撤销本会话最近修改会校验原操作、预期版本和原值，创建补偿事件。历史保留改前记录及安排时区，撤销恢复原时区；仅修改标题不重写安排时区。已完成任务只允许标题修改，改期需先撤销完成；执行事实不随改名改变。

移动和云同步仍暂缓。原 Ticket 06 的跨端冲突、目标安排合并与原 Ticket 11 的完整日历仍未完成。目标日期已有同任务安排时拒绝改期并给出冲突提示。撤销按钮是当前会话最近修改入口，重启后历史保留但尚未提供历史操作浏览器。

## 验证结果

- pnpm typecheck、前端与 Tauri debug 构建：通过。
- pnpm test：21 项通过。
- pnpm test:native：16 项真实 SQLite 测试通过。
- pnpm test:desktop：13 项实际 Tauri/WebView2 验收通过，pageErrors 为空。
- 新增存储测试覆盖稳定 ID、改期与撤销重开、重复命令、过期修改、最后一步失败回滚、已完成事实保护以及从 v2 数据库迁移后历史/outbox 保留。
- 原生验收覆盖空标题、修改标题和日期、按日查看、撤销、同一详情连续保存、杀进程重启后的标题与日期恢复。
- 首条编辑存储测试因接口未实现失败，完成事务实现后通过。
- 实际桌面验收曾复现“列表已更新而编辑框仍为旧版本”；改为使用已确认保存结果作为新草稿基线后，连续保存回归通过。后台刷新仍不会覆盖未保存草稿。

[机器结果](evidence/desktop-edit/native-smoke.json) · [编辑与日期截图](evidence/desktop-edit/desktop-edited.png)

复现：

```powershell
pnpm typecheck
pnpm test
pnpm test:native
. .\scripts\native-env.ps1
pnpm --filter @praxis/desktop exec tauri build --debug --no-bundle
$env:PRAXIS_EVIDENCE_DIR='docs/evidence/desktop-edit'
pnpm test:desktop
```

原生测试使用隔离数据库，拦截外部 HTTP(S)，不修改系统适配器；没有用浏览器模拟替代原生执行。

## Standards

沿用已确认基准 bf7c457817544a910d16f3a75f707039016e7788，本轮重点审查 67a7aa0 后增量。

- P2：保存后编辑器可能重建于旧查询数据，使用过期版本。已将已确认 receipt.after 与新编辑会话同步设置，原生连续保存两次通过。
- P3（判断项）：编辑与完成重复实现未确认命令重试生命周期。已集中到内部 RetriableCommands，业务匹配与规则仍在各用例。
- 定向复核：两项关闭，无剩余问题。

## Spec

- P2：保存后编辑框可能保留旧标题/版本，下一次保存错误冲突。已修复并通过原生回归。
- 定向复核：问题关闭，无剩余问题。

统计：Standards 2 项（最严重 P2）已解决；Spec 1 项（P2）已解决。
