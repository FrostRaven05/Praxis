# P0-02 个人数据兼容清单

日期：2026-11-11  
范围：整个产品只做个人管理，同账号双端同步保留。  
依据：[个人 PRD](../prd-mvp-v0.1.md)、[当前计划](../mvp-development-plan-2026-11-09.md)。

本阶段交付字段与版本映射、保留规则、个人合成样本和存储回归证据。没有新增数据库迁移，没有连接真实用户库。P0-03 接着统一查询与命令入口；P1、P2、P3 负责界面、新任务 XP 与新 AI 流程。本清单不表示这些后续功能已完成。

## 1. 数据身份和版本

一个账号在同一服务上的任务，以账号作用域和原任务 ID 识别。项目归属是可变字段，不参与任务身份、采用防重或将来的 XP 主键。不同账号或不同服务中的同名、同 ID 任务不自动合并。

本地 `local_profile.owner_id` 是数据库内身份，不能假定等于登录用户 ID。Windows 按服务地址和账号选择数据目录；Android 按账号选择数据库，再按工作空间隔离实体。未登录本机资料继续留在原数据库，不能通过替换 owner 将其并入新账号。恢复必须选回对应账号的数据位置，不能把一份数据库写入另一账号的活动路径。

| 层次 | 当前版本与字段 | 兼容要求 |
| --- | --- | --- |
| 桌面结构 | `_sqlx_migrations`，最高25；历史序号无0015 | 保留已执行脚本与校验和，不重编号、不改旧迁移。`Store::open` 在旧库升级前备份，再运行原迁移 |
| 手机结构 | Capacitor schema 1→2→3→4→5 | 1为初始任务；2增加原文；3增加工作空间与实体；4增加原配对同步；5增加实体同步。与桌面25不是同一编号体系 |
| 原生编辑 | `tasks.version` / `projects.version`，从0起；另有 `projects.plan_version` | 本地比较并交换，保留当前版本；项目计划版本单独检查。不能用网络版本覆盖它们 |
| 手机编辑 | `mobile_entities(workspace_id,id).version`，从1起 | schema 3 导入旧任务时实体初值为1，原 `tasks` 表仍保留；后续使用实际实体版本，不按桌面0起规则换算 |
| 同步实体 | `lan_entities.version`、API实体版本、手机 sync shadow | 独立的远端版本。桌面接收时维护本地CAS；手机本地实体版本与 shadow 分别保存。不以 `wireVersion - 1` 计算编辑版本 |
| 操作与回执 | `operation_id`、`run_id`、`expectedVersion` | 重试沿用原操作和内容，内容变了必须新操作。结果不明先查原回执，不重新生成任务ID |
| AI本地草稿 | `AiPlannerDraft.schema = 1` | 保留旧字段及待采用命令。将来的精简界面不能通过重建草稿丢掉ID、旧依赖、奖励或输入 |

依据：[桌面打开与迁移](../../apps/desktop/src-tauri/src/store.rs)、[账号目录](../../apps/desktop/src-tauri/src/accounts.rs)、[手机结构升级](../../packages/storage-mobile/src/native.ts)、[手机迁移](../../packages/storage-mobile/src/migration.ts)、[实体映射](../../apps/desktop/src-tauri/src/store/entities.rs)。

## 2. 保留清单与新入口处理

| 编号 | 数据与现有存放位置 | 必须保留 | 后续个人入口处理 |
| --- | --- | --- | --- |
| C01 | 独立任务 `tasks.project_id IS NULL`；手机 `data.projectId` | ID、owner、标题、说明、版本、来源 | 全部个人待办直接读取；不要求先安排到今天 |
| C02 | 项目 `projects`、`project_context`；手机 project实体 | 原ID、名称、目标、目标日期、生命周期、恢复信息 | 新建只必填名称，旧高级字段保留兼容访问；不自动把任务全完成当作项目验收 |
| C03 | 项目归属 `project_id`、`section_id` | 原任务及相关历史，不复制任务 | 独立任务纳入项目可沿用 `assign_project`；已有项目间移动使用 `ProductivityAction::Move` 及影响预览版本，不能走普通字段保存 |
| C04 | 树形 `parent_task_id`、`task_rank`、`task_dependencies`、汇总安排 | 全部父子与排序、依赖、原进度语义 | 新平铺任务另按平铺统计；旧树按有效叶子统计并标识。坏引用/循环提示处理，不能静默删父节点或拍平成多份任务 |
| C05 | `status` 的 todo/in_progress/completed | 状态与完成事实、撤销记录 | 新核心入口显示三态；更新通过原事务与版本检查 |
| C06 | 桌面 `status='todo'` + `waiting=1`，`waiting_for`、`waiting_note`；手机同样有等待标记，旧同步还可能带waiting状态 | 原状态与等待标记、等待对象及说明 | 兼容展示“等待”。不把原生status直接改成waiting，也不在简化入口自动清除等待信息 |
| C07 | blocked/cancelled，`status_reason`、`cancelled_from`、`cancelled_reason` | 阻塞与取消原因、可恢复历史 | 不批量转成todo/completed。兼容入口明确显示，统计不能将取消叶子算作完成 |
| C08 | 日期级截止 `deadline_value={kind:'date',date}`；手机 `data.dueDate` | 自然日原值和工作空间时区设置 | 按个人工作空间自然日分组，到次日才逾期。没有截止就是无日期，不由安排/目标日期补齐 |
| C09 | 确定时刻 `deadline` + `deadline_time_zone`、`deadline_value={kind:'instant',atUtc,displayTimezone}`；手机 `data.desktop` 扩展 | 原时刻、显示时区、精度 | 日期投影只是兼容摘要；不能用dueDate覆盖旧时刻，也不能在只改标题时丢掉desktop扩展 |
| C10 | `plan_value`、`daily_plan_items` 的日期/时区/removed/is_summary；`project_schedules`；项目target_date | 每日安排历史、计划、排期窗口、目标日期分别保存 | 新待办按截止分组。schema 11 的历史迁移会从最新有效非汇总安排初始化plan，但不改截止或甘特窗口；之后不再次重算历史 |
| C11 | `completed_at`、`active_completion_id`、`execution_records` | 已知事实及撤销；未知日期仍null | 旧完成任务不因读取/升级生成今天的完成时间。新任务XP的“今天完成”将来只用可信完成日期 |
| C12 | `deleted_at`、`trash_batches`、`deletion_tombstones` | 删除与恢复信息、旧原文 | 简化导航不能物理删除历史。删除/恢复影响新进度和XP属于P1/P2，不能把旧奖励规则顺便改掉 |
| C13 | `cultivation_credits/state/achievements/reward_agreements`及目标任务关联 | 旧修为、境界、愿望、已领取奖励和来源ID | 旧规则按行动包记修为，历史已删除完成任务可能仍保有贡献。新任务XP独立记账，不混加、不回写；迁移规则归P2-02 |
| C14 | 桌面 `ai_applications(owner_id,operation_id)`唯一run；手机来源实体 `aiApplication/aiApplications` 和本地待提交缓存 | 采用命令、生成与操作ID、任务ID、回执、撤销信息 | 桌面回执留在采用设备，正式任务正常同步。新流程保持生成设备采用边界，不把跨设备看到了任务当作另一设备可以再次采用 |
| C15 | 浏览器/WebView localStorage 草稿及手机AI缓存 | 原输入、手动编辑、旧模式、依赖/奖励、pendingApply/receipt | 保留账号与服务作用域；旧草稿仍能从兼容入口查找。设备通过本地存储自然隔离，待提交缓存还包含数据库/工作空间作用域。P3再适配新个人草稿 |
| C16 | `sync_outbox`、`lan_entity_pending/local/history/resolutions`；手机 `mobile_operations/import_history`、两套 pending/shadow/conflict/rejected | 操作原文、远端基础版本、同步游标/代次、冲突双方和被拒内容 | 不因升级或精简界面清队列、重新编号或自动换账号绑定。outbox/operations兼有重放历史，行数不等于当前未同步数 |
| C17 | 其他个人实体、设置、未知表与未知扩展字段 | 日历、习惯、记录、回顾、原文及未知内容 | 保留已有访问；备份按整个库进行，不能只导出新页面的可见字段 |

## 3. 备份和恢复边界

Windows 现有备份用 `VACUUM INTO` 保存已提交的整库状态，包括WAL已提交内容。恢复先校验完整性、外键、单一本地身份及支持版本，再复制到独立 recovered 数据库，迁移副本，成功后切换指针；原库与备份继续存在。损坏备份、路径穿越或不支持版本沿用原拒绝逻辑，不通过“清空重试”恢复。

手机已有“工作空间JSON导出”只包含该工作空间的实体和操作历史，不包含完整数据库的配对、同步pending/conflict、原表、所有账号、浏览器草稿或安全凭据。因此不能作为清队列、删库或替换账号库的前提。本阶段用宿主SQLite整库副本证明内容可保存和重开；没有新增Android整库备份界面，真机恢复旅程留待P4。

桌面数据库备份也不含localStorage草稿、账号认证文件和远端生成记录；手机已采用来源实体与未提交缓存的覆盖范围也不同。后续需要迁移这些内容时须分别保留本地草稿/缓存，并验证账号作用域，不能宣称单个DB/JSON文件覆盖所有AI恢复内容。

## 4. 合成样本与验证对应

样本：[personal-compatibility-fixtures.json](personal-compatibility-fixtures.json)。只含测试ID、固定时间和人工文本，无真实账号资料。

| 用例 | 实际验证 | 覆盖的个人验收部分 |
| --- | --- | --- |
| PC01 | 桌面真实schema10→25；原ID、version7、原文、完成标准不变；原队列、安排与事件逐行相等；旧时刻转换保持精度和时区；未知完成时间仍null | P-AC03、P-AC07、P-AC14的数据兼容部分 |
| PC02 | 升级前自动备份全部原表相等；再次打开当前库全部表相等，不重复映射 | P-AC14的升级与重启部分 |
| PC03 | 当前桌面真实命令：独立→项目A→项目B仍一条任务，版本7→8→9；重放无新增；过期写入被拒绝 | P-AC03、P-AC04的存储部分 |
| PC04 | 桌面57表（56原表+1未知表）备份恢复逐列相等，含同步冲突、3条outbox历史、旧奖励/credit、未知日期、AI回执；恢复后再次采用原命令无新增 | P-AC12、P-AC14的数据部分 |
| PC05 | 手机结构2→3→4→5脚本在宿主SQLite执行；旧任务、原文、安排、事件与未发出outbox保留；原任务映射到实体version1；重开相等 | P-AC03、P-AC07、P-AC14的数据部分 |
| PC06 | 手机整库副本及重开后全部表相等；原等待标记、blocked/cancelled、旧时刻扩展、未知完成日期、冻结待发命令、真实同步冲突与未知表保留 | P-AC07、P-AC14的数据部分 |
| PC07 | 手机任务纳入项目保持ID且仅增一个版本，重复命令防重、旧版本拒绝；两个独立账号库的相同任务ID不合并，跨身份重绑被拒且不改数据 | P-AC03、P-AC13的数据部分 |
| 复用回归 | API同账号双设备与不同账号隔离；旧AI草稿作用域/恢复、手机AI采用缓存与回执；旧修炼、损坏备份和旧树/时区规则测试 | 保留现有回归保障，不等同于新页面或真实模型验收 |

新增测试：[桌面兼容](../../apps/desktop/src-tauri/tests/personal_compatibility.rs)、[手机存储兼容](../../packages/storage-mobile/src/personal-compatibility.test.ts)。相关原实现：[成长](../../apps/desktop/src-tauri/src/store/cultivation.rs)、[手机导出](../../packages/storage-mobile/src/workspace.ts)、[AI草稿](../../apps/client/src/ai-planner-model.ts)、[手机AI回执](../../apps/client/src/ai-mobile-adapter.ts)。

## 5. 交给后续阶段的约束

1. **P0-03**：统一按当前账号读全部个人任务、typed截止及等待标记的投影，明确原生CAS与网络版本来源，复用个人事务和Move命令。避免只改标题时提交空截止、只查询Today或丢失未知扩展字段。
2. **P1-04/P1-05**：三态界面与旧状态/层级兼容入口共存，提供版本化撤销和明确的保存/同步反馈。高级字段不再必填，但原值保留。
3. **P2-01/P2-02**：新XP用账号内稳定任务ID防重，与旧行动包修为隔离；未知完成时间不能计入今天，旧奖励不能重复领取或自动失效。
4. **P3-01/P3-04**：新个人草稿精简，不改写旧schema1草稿；未知采用结果查原回执，保留本地未提交缓存。跨设备同一草稿采用仍不开放。
5. **P4-02/P4-03**：实际Windows/Android、完整恢复和真实模型仍需独立验收。本文仅完成数据兼容基线，不勾选完整P-AC03、P-AC07、P-AC14产品验收。

本次结果与可复跑命令见[实施记录](implementation-p0-02.md)；原M0冻结证据保留原样，不用新文档覆盖旧哈希。
