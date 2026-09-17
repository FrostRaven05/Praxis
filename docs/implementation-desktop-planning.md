# 桌面重点、估时、容量与收件箱

2026-09-17，D03 完成原 Ticket 10 的桌面本地部分。

重点属于每日安排，与普通待办互斥，支持追加、上下移动和取消。建议聚焦 1–3 项，无数量硬上限。排序规则在共享应用层，整批更改由 SQLite 事务保存。

预计投入为 1–1440 分钟，留空为 null；每日容量为 0–1440 分钟，留空为未设置。负载统计所选日期全部安排（包含已完成），不是剩余工作量。未知估时单独计数；超量仅提醒，不移走任务。

收件箱和应用内 Ctrl+Shift+N 默认创建无日期任务；选择日期后创建安排并保留任务 ID。快捷键不是操作系统级快捷窗。

迁移 0004 保留原历史和 outbox，增加安排字段、每日容量及容量历史。修改包含幂等操作 ID、版本复核和同事务历史/outbox。云端尚未接通。

## 验证

- 类型检查通过；TypeScript 全量 24 项、Rust 全量 21 项通过。
- 真实 Tauri/WebView2 原生流程 16 项通过，页面错误为 0。
- 覆盖未知估时与零容量、101 项重点排序、重复操作、版本冲突整批回滚、最后一步写入失败回滚、强制结束进程后的恢复。
- 首条存储测试与共享排序回归均先确认失败，再实现通过。
- 测试使用隔离数据库、真实原生 IPC；拦截外部 HTTP(S)，不修改系统网络设置。

[机器记录](evidence/desktop-planning/native-smoke.json) · [桌面截图](evidence/desktop-planning/desktop-planning.png)

复现：依次运行 pnpm typecheck、pnpm test、pnpm test:native；加载 scripts/native-env.ps1，运行 pnpm --filter @praxis/desktop exec tauri build --debug --no-bundle，然后设置 PRAXIS_EVIDENCE_DIR=docs/evidence/desktop-planning 并运行 pnpm test:desktop。

移动真机、云端收敛和安装包未新增验收。独立预览使用 pnpm desktop:preview，内置页面无需 Vite 服务。

## Standards

沿用已确认基准 bf7c457817544a910d16f3a75f707039016e7788，本轮重点审查 f6401f0 后增量。

- P2：React 内计算重点追加和排序，违反共享业务边界。已移至共享 planning.ts，界面仅调用。
- P2：批量修改的 100 项隐含上限导致更多重点无法排序。已删除限制，新增 101 项排序回归。
- 定向复核：两项均闭环，无剩余问题。

## Spec

未发现 D03 范围内的可操作问题。重点分组、未知估时、零容量、超量保留任务和无日期收件箱符合本轮要求。移动、云同步及系统级快捷窗不在结论范围。

统计：Standards 2 项（最严重 P2）已解决；Spec 0 项。
