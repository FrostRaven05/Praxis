# Praxis MVP Tickets

生成日期：2026-09-16。依据 TECHNOLOGY.md（2026-09-14 决策）与 Spec.md V1.2。用户已选择本地 Markdown 作为任务系统。

共 **32 张独立 Tickets**。用户已指示开始实现，已发布至 issues 子目录。原 drafts 保留为拆分历史；以 issues 中的状态为准。

## 拆分原则与执行规则

- 拆分时项目仅有产品和技术文档，无已有代码需要预重构。工程搭建跟随第一个能实际录入任务的切片完成。
- 01–02 是离线原生切片，03 起贯穿登录、同步服务及云端约束；每项新增业务都补相应迁移、用例、界面和验证，不设只有“建全部表”或“做所有 API”的横向任务。
- 下列 Blocked by 只列直接前置；传递前置不重复罗列。编号为一种合法拓扑顺序，并不要求严格按编号串行。
- 技术上无前置的初始 frontier 为 01。之后只领取所有阻塞项均完成的 Ticket；ready-for-agent 表示可被认领的任务定义，不代表可跳过阻塞。
- M0 的 01–09 是技术验证放行条件。M1–M3 的技术阻塞按各 Ticket 记录；项目实施节奏遵循先验收 M0 再扩展功能，避免把同步推迟到最后。该阶段门槛与逐项技术依赖分别表达。
- 32 是最终集成和发行验收，不替代前面各 Ticket 的测试。它不承担尚未实现的产品功能。
- Windows + Android 是第一组验证设备；iOS/macOS 的环境、签名和首发范围在实施前落实，不能用缺环境作为“已通过”依据。
- M0 不接入完整推荐算法：05 从任务详情验证安排幂等，19–20 再接入真实建议与接受。
- AI、智能重排、重复任务、小组件、全局快捷窗、高级依赖和外部集成留在 P1/P2，不发布为本次 ready-for-agent 任务。
- Tickets 生成阶段未开通云服务或发布远端 Issue；后续开发进度见实施状态。

## 编号方案

每项包含标题、直接阻塞项和交付行为；点击标题查看完整验收清单。

1. **[01 — 桌面离线录入并保留临时任务](issues/01-desktop-offline-capture.md)**（M0）  
   **Blocked by:** 无。  
   **What it delivers:** 用户在桌面应用只输入标题即可保存任务，关闭应用后再次打开仍能看到。

2. **[02 — 在移动端离线录入同样的任务](issues/02-mobile-offline-capture.md)**（M0）  
   **Blocked by:** 01。  
   **What it delivers:** 用户在手机常驻添加入口录入临时任务，离线重启后继续查看。

3. **[03 — 登录后让双端看到同一任务](issues/03-authenticated-task-sync.md)**（M0）  
   **Blocked by:** 02。  
   **What it delivers:** 同一用户登录桌面与手机后，一端新增的任务和每日安排能出现在另一端。

4. **[04 — 保留并解决两端任务编辑冲突](issues/04-task-conflict-resolution.md)**（M0）  
   **Blocked by:** 03。  
   **What it delivers:** 两端离线修改任务标题或重要度后，用户能看到并解决冲突，不丢失另一端输入。

5. **[05 — 把同一任务安排到某日且双端去重](issues/05-daily-plan-idempotency.md)**（M0）  
   **Blocked by:** 04。  
   **What it delivers:** 用户从任务详情将已有任务加入指定日期，连点或两端同时操作都只产生一条安排。

6. **[06 — 改期、处理并发改期并支持撤销](issues/06-reschedule-and-undo.md)**（M0）  
   **Blocked by:** 04、05。  
   **What it delivers:** 用户把任务的每日安排改到另一日，可撤销；两端改到不同日期时能明确选择。

7. **[07 — 完成任务并撤销误完成](issues/07-complete-and-undo.md)**（M0）  
   **Blocked by:** 04、05。  
   **What it delivers:** 用户勾选完成后，双端状态及完成事实一致；误完成可以撤销。

8. **[08 — 断线及崩溃后继续同步未提交操作](issues/08-sync-recovery.md)**（M0）  
   **Blocked by:** 06、07。  
   **What it delivers:** 用户经历断网、应用崩溃或长期离线后，仍能恢复未完成同步并看到可处理的错误。

9. **[09 — 在安装端验证任务提醒与文件导出](issues/09-native-capability-probe.md)**（M0）  
   **Blocked by:** 02。  
   **What it delivers:** 用户在桌面和手机为一条本地任务设置测试提醒，并将其导出为本地文件。

10. **[10 — 今日重点、负载与收件箱录入](issues/10-today-focus-inbox.md)**（M1）  
   **Blocked by:** 05、07。  
   **What it delivers:** 用户管理今日重点与普通待办，随手记录无日期事项，并看到当天负载。

11. **[11 — 按日浏览已安排任务和执行事实](issues/11-calendar-plans-history.md)**（M1）  
   **Blocked by:** 06、07。  
   **What it delivers:** 用户切换日期查看已安排事项及完成记录，并直接往未来日期添加任务。

12. **[12 — 创建项目并拆出可执行任务](issues/12-project-task-breakdown.md)**（M1）  
   **Blocked by:** 05、07。  
   **What it delivers:** 用户写出项目预期结果，拆成任务并将原任务加入今日，也能把临时事项归入项目。

13. **[13 — 用子任务拆解工作并正确汇总父任务](issues/13-subtasks-rollup.md)**（M1）  
   **Blocked by:** 12。  
   **What it delivers:** 用户把任务细分为子任务，父任务显示汇总进度，完成统计不重复计算父子项。

14. **[14 — 管理项目生命周期及保留已有安排](issues/14-project-lifecycle.md)**（M1）  
   **Blocked by:** 12。  
   **What it delivers:** 用户暂停、恢复、完成或归档项目，已承诺的每日任务仍可明确处理。

15. **[15 — 在甘特图查看和编辑日粒度排期](issues/15-gantt-schedule.md)**（M2）  
   **Blocked by:** 12。  
   **What it delivers:** 用户看到项目任务条、今日线和未排期列表，并在桌面及手机修改计划日期。

16. **[16 — 编辑前置依赖并阻止并发成环](issues/16-task-dependencies.md)**（M2）  
   **Blocked by:** 13、15。  
   **What it delivers:** 用户在任务详情及甘特中维护前置关系，能看到依赖连线并获得无效依赖提示。

17. **[17 — 预览受影响排期并确认或撤销调整](issues/17-schedule-impact-preview.md)**（M2）  
   **Blocked by:** 06、16。  
   **What it delivers:** 用户推迟甘特任务时，先看受影响任务和每日安排偏差，再决定是否应用方案。

18. **[18 — 通过看板推进、阻塞和取消任务](issues/18-kanban-status.md)**（M2）  
   **Blocked by:** 07、12。  
   **What it delivers:** 用户从看板切换任务状态，所有现有视图显示同一结果，并能查看阻塞原因。

19. **[19 — 按计划和依赖生成可解释的今日建议](issues/19-today-recommendations.md)**（M2）  
   **Blocked by:** 10、14、16、18。  
   **What it delivers:** 用户打开今日页即获得有来源的可执行候选，无 AI、断网时也能使用。

20. **[20 — 接受、忽略或改日处理今日建议](issues/20-recommendation-decisions.md)**（M2）  
   **Blocked by:** 06、19。  
   **What it delivers:** 用户把建议加入今日或设为重点，也可今日忽略或明确改到未来日期。

21. **[21 — 在日历查看未来候选并主动安排](issues/21-calendar-candidates.md)**（M2）  
   **Blocked by:** 11、20。  
   **What it delivers:** 用户按日期浏览项目计划候选，明确区分建议、已安排和已发生的执行事实。

22. **[22 — 记录跨日部分推进和实际投入](issues/22-partial-execution.md)**（M3）  
   **Blocked by:** 11、13、18。  
   **What it delivers:** 用户每天记录同一任务的推进说明，最后完成时项目只计算一次完成。

23. **[23 — 生成并保存带快照的晚间总结](issues/23-daily-review.md)**（M3）  
   **Blocked by:** 10、22。  
   **What it delivers:** 用户从今日页生成结构化晚间总结，离线补充笔记和明日关注后保存。

24. **[24 — 处理昨日及总结中的遗留事项](issues/24-leftover-resolution.md)**（M3）  
   **Blocked by:** 06、18、23。  
   **What it delivers:** 用户选择把遗留任务安排明天、指定日期或待安排，也能标记阻塞或取消。

25. **[25 — 基于事实生成、编辑和导出周报](issues/25-weekly-report.md)**（M3）  
   **Blocked by:** 09、21、23。  
   **What it delivers:** 用户无需每天写总结，也能生成按项目汇总的周报，编辑下周重点并保存及导出。

26. **[26 — 事实修正后提示更新回顾版本](issues/26-review-refresh.md)**（M3）  
   **Blocked by:** 25。  
   **What it delivers:** 用户修正执行事实后能看到相关总结和周报可更新，旧版本和自己的文字仍保留。

27. **[27 — 设置任务、晚间总结和周报提醒](issues/27-reminder-settings.md)**（M3）  
   **Blocked by:** 09、25。  
   **What it delivers:** 用户选择提醒时间与设备，在移动端收到本地提醒并打开相应任务或回顾。

28. **[28 — 导出完整项目数据及回顾历史](issues/28-full-data-export.md)**（M3）  
   **Blocked by:** 09、26。  
   **What it delivers:** 用户从设置导出完整数据包，包含项目执行和回顾历史，而非只有当前任务列表。

29. **[29 — 提供同一账号的 Web 在线补充入口](issues/29-web-online-entry.md)**（M3）  
   **Blocked by:** 17、26。  
   **What it delivers:** 用户通过浏览器登录，在线访问今日、项目三视图和回顾，与安装端看到同一份数据。

30. **[30 — 安装升级后保留离线数据并继续工作](issues/30-safe-client-upgrade.md)**（M3）  
   **Blocked by:** 08、26。  
   **What it delivers:** 用户安装新版客户端后保留已有数据、历史与待同步操作，失败时能安全恢复。

31. **[31 — 在独立部署环境使用并恢复账号数据](issues/31-service-deployment-restore.md)**（M3）  
   **Blocked by:** 08。  
   **What it delivers:** 用户连接受 TLS 保护的独立服务使用双端同步，服务恢复后能够继续访问数据。

32. **[32 — 用可安装版本完成首版端到端验收](issues/32-mvp-release-validation.md)**（M3）  
   **Blocked by:** 17、24、27、28、29、30、31。  
   **What it delivers:** 用户安装候选版本后完整跑通项目拆解、今日执行、总结与周报闭环，团队获得可复现的发行验收证据。

## 需求验收映射

每条场景由以下 Ticket 实现，再在 32 的安装端总验收中重跑。

| Spec §8.1 | Tickets | 覆盖行为 |
|---|---|---|
| 1 | 12、13、15、16、18 | 项目五任务与三视图同源 |
| 2 | 19 | 依赖先于优先级 |
| 3 | 05、10、20 | 加入今日/重点且重复接受去重 |
| 4 | 01、02、06、07、10、12 | 临时待办录入、重要、完成、改期及归属 |
| 5 | 11、21 | 日历已安排/候选分离与未来添加 |
| 6 | 07、18、19、20、21 | 完成联动及未来不自动提前 |
| 7 | 16、17 | 依赖无环及排期影响预览 |
| 8 | 07、13、22 | 跨日推进及父子统计去重 |
| 9 | 23、24、26 | 日总结、遗留与历史保留 |
| 10 | 25、26、28 | 无 AI/无日总结的周报、编辑与导出 |
| 11 | 01–08、23、30 | 双端离线与恢复；32 真机总验收 |
| 12 | 10、14、19 | 超量、未知估时、暂停、无排期提示 |

技术路线额外约束：认证与隔离 03；冲突 04–08；原生提醒/导出能力 09；批量撤销 17/24；回顾版本 23/25/26；完整提醒 27；完整导出 28；Web 在线入口 29；迁移升级 30；服务备份恢复 31。

## 阶段放行

| 阶段 | Tickets | 放行证据 |
|---|---|---|
| M0 | 01–09 | 双设备断网、崩溃、冲突、幂等、改期和完成撤销通过，原生通知/文件能力有实测记录 |
| M1 | 10–14 | 今日、收件箱、日历、项目拆解及生命周期可操作且同步 |
| M2 | 15–21 | 甘特/看板、依赖、排期预览、规则建议和接受闭环通过 |
| M3 | 22–32 | 事实推进、日总结、周报、提醒、导出、升级、部署及全部首版场景通过 |

## 桌面优先调整

2026-09-16 用户要求优先完善桌面。按 [桌面实施顺序](../../docs/desktop-first.md) 推进，移动和同步原有验收保留。已完成 [D01 桌面完成与撤销](issues/D01-desktop-complete-undo.md)；不将此视作 Ticket 07 双端完成。

已完成 [D02 桌面编辑与改期](issues/D02-desktop-edit-reschedule.md)，原 06/11 的跨端和完整日历验收仍保留。

## 实施状态

Ticket 01 已完成：Windows 桌面离线录入、原子持久化、失败重试与重启恢复均通过验证。Ticket 02 已实现移动适配与 Android 工程，宿主测试通过，等待构建环境和真机验收；其余状态以 issues 中的记录为准。

已完成 [D03 重点、估时与收件箱](issues/D03-desktop-focus-inbox.md)、[D04 项目基本管理](issues/D04-desktop-projects.md)。原 10/12 的完整业务字段、移动与同步验收仍以各 Ticket 为准。

已完成 [D05 任务详情与无日期编辑](issues/D05-desktop-task-details.md)，补齐桌面任务字段；子任务和父子统计为下一批。

D06 桌面多级子任务与叶子进度已完成；验收见 docs/implementation-desktop-subtasks.md。原 13 的排序、父节点移动及跨端验收保留未完成。

D07：桌面项目生命周期、排序移动、看板、甘特图及基础依赖顺延已实现，验收见 docs/implementation-desktop-project-workspace.md。原 13–18 的跨端同步与移动设备验收仍未完成。

D08：追踪项目侧栏快捷入口与紧凑项目页已完成，保留原有追踪标记；详见 docs/implementation-desktop-tracked-projects.md。

D09：紧凑桌面清单已完成，删除宣传及重复信息，折叠低频操作；验收见 docs/implementation-desktop-compact.md。

D10：按 DESIGN.md 统一桌面设计系统，验收见 docs/implementation-desktop-design-system.md。
