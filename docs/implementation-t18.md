# T18 — 固定日历重复任务

实现范围为 Windows 本地。重复模板独立于任务，支持每天、每隔 1–366 天、指定 ISO 星期（周一=1）。以开始日期和建立时工作空间 IANA 时区为锚。只产生顶层任务的计划日期，不产生硬期限，也不因完成时间移动后续规则。

## 使用

先在时间设置确认工作空间时区，再打开“重复任务”，输入标题、开始日期、间隔或星期及项目，保存规则。每条规则显示已检查日期、未来30天截止日期和剩余发生数量。“补齐下一批”每次生成最多100项；长期离线从开始日期/上次水位继续，没有跳过旧区间。可重复点击直至剩余为0，再到近期/今日页面处理生成任务。查询只读取，写入仅由明确生成命令执行。

停止模板需确认，保留历史和已经生成的未来任务。结束项目前，必须先停止启用模板，并按项目处理流程处置未终结任务；不会把这些任务静默完成。暂停项目不停止模板。项目删除由 T15 整合停止模板和未来实例处理。

## 数据与集成

- migration `0013_recurrence.sql`：模板、任务 occurrence 引用与唯一键、项目终结保护、不可变发生身份、顶层约束、本次编辑例外标记。
- `Store::recurrence_snapshot()`：纯读 `{templates:[{template,through,remaining}]}`。规则时区解释“今天”，目标为本地今天+30日。
- `Store::recurrence_command(&RecurrenceCommand)`：事务内 Create / Expand / Stop，校验重试载荷，写审计与本地队列。展开每批1–500项。水位包括没有发生项的日期，批次中断则停在最后实际处理日。
- `RepeatView` 通过 `recurrence_snapshot` / `recurrence_command` 调用；表单未确认结果的同载荷重试保持操作ID。
- 自然键为 `(recurrence_template_id, occurrence_key)`，其中 occurrence_key 是原定 `YYYY-MM-DD`，单次改期仍保留。任务ID为 UUID v5，namespace=`Uuid::NAMESPACE_URL`，UTF-8 name=`praxis:occurrence:{模板UUID}:{YYYY-MM-DD}`。此规则提供跨语言固定输入，后续 T28 仍需跨语言向量验证和服务器唯一约束。
- 模板停止采用乐观版本；规则未来生效、覆盖预览与时区迁移由 T19 扩展，不能通过编辑原始规则回写历史。

## 验证

`tests/recurrence.rs` 覆盖读查询不写、跨重启持久化、长期离线分批和重放、每天/间隔/星期、独立UUID任务身份、只生成计划、单次修改后无重复、停止保留未来及项目终结保护。2026-10-09 定向测试 `cargo test --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --test recurrence`：3 组全部通过；`pnpm typecheck` 通过。完成旧发生项后再次展开仍保持原始间隔日历。最终桌面联调由主任务统一执行。

