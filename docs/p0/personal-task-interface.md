# P0-03 个人任务查询与变更接口

日期：2026-11-11  
产品范围：个人账号、本地数据、同账号设备同步。  
前置约束：[P0-02数据兼容清单](personal-data-compatibility.md)。

## 调用入口

应用通过 [personal-task-storage.ts](../../apps/client/src/personal-task-storage.ts) 的 `personalTasks.read()` 与 `personalTasks.change(base, taskId, change)` 读取和修改个人任务。平台选择、可信账号作用域、原始数据保留、本地版本与命令格式由适配模块处理。调用方不传owner，不将网络版本转换为编辑版本。

```typescript
const base = await personalTasks.read();
const all = base.query.list();
const independent = base.query.list(null);
const projectTasks = base.query.list(projectId);
const task = base.query.task(taskId);
const groups = base.query.groups;
const progress = base.query.progress(projectId);

await personalTasks.change(base, taskId, { type: "edit", title: "整理发布材料" });
// 修改成功后重新读取；结果不明时，先使用原base和原change重试。
```

`base` 是一次读取结果，应按不可变快照使用。`work` 保留原有工作区形状；`query` 使用相同任务ID提供列表、详情、待办与统计。新核心页面使用此入口；既有层级、排期、回收站、记录、习惯及AI高级操作继续保留原专用命令。

## 统一读取规则

| 查询 | 口径 |
| --- | --- |
| `query.list()` | 当前账号/工作空间全部有效任务，含独立、项目任务、旧状态和已完成任务；不要求加入今日或填写日期 |
| `query.list(null)` / `list(projectId)` | 通过可变项目字段筛选同一任务，归属不参与身份 |
| `query.task(id)` | 返回同一读取结果中的同一个投影对象；不存在则null，不去其他账号查找 |
| `query.groups` | overdue/today/later/undated四组；包含未完成的todo、in_progress及旧waiting/blocked；completed单独提供，cancelled保留在列表但不进入待办 |
| `query.progress(projectId)` | 新平铺任务按有效任务统计；有旧层级或旧状态时采用有效叶子兼容统计，取消叶子不算完成也不占分母；旧父子不双计。逾期数使用同一统计口径 |
| 空项目 | total=0、percentage=null、allTasksCompleted=false |
| 全部任务完成 | 仅返回任务统计事实，不改项目生命周期、归档或成果验收 |
| 异常历史 | 重复任务ID、统计中的未知状态、缺父节点或循环明确报错，不改写、删除或拍平原资料 |

所有任务使用原编辑版本。桌面快照补充 `rawStatus`、`waiting`、`statusReason`、`completionCriteria`，项目补充目标与目标日期；手机从原实体及desktop兼容字段投影为相同的 `WorkSnapshot`。手机实体与原始扩展仍留在存储中，不用精简后的读取对象覆盖整条实体。

## 日期与旧状态

- 日期级截止保留 `{kind:'date',date}`，按工作空间时区自然日分组，跨到次日后逾期；未配置时区时仅使用设备时区作读取回退，不写入设置。
- 确定时刻保留 `{kind:'instant',atUtc,displayTimezone}`。到达该时刻即进入逾期；未到时按原显示时区判断今天或之后，并按原时区显示。不能用手机日期摘要覆盖精确时刻。
- 组内按截止自然日、创建时刻、任务ID稳定排序；无日期按创建时刻与ID。计划、每日安排和项目目标日期不填充任务截止。
- 桌面旧等待通过rawStatus和waiting标记保留；手机旧status=waiting也能读取。完成/取消事实优先于过期等待标记，阻塞/取消原因继续留在原数据与兼容入口。
- 手机只改标题或说明时保留旧时刻及未知字段；明确改截止时更新typed兼容字段。明确将旧时刻改成同一天的日期仍然生效；明确清空截止才清空相关字段。
- 历史已完成但日期未知的任务，读取或仅编辑内容均保持未知；只有实际从非完成转为完成才记录新的完成时刻。同步保留显式未知值，并使用已知完成时刻而非最后编辑时间。没有完成时间字段的旧协议仍沿用原兼容回退。

实现：[共同规则](../../packages/application/src/personal-tasks.ts)、[手机投影](../../packages/storage-mobile/src/personal-tasks.ts)、[原生快照](../../apps/desktop/src-tauri/src/store/productivity.rs)、[实体映射](../../apps/desktop/src-tauri/src/store/entities.rs)。

## 变更与可靠性

| 变更 | 输入 | 实际提交与保护 |
| --- | --- | --- |
| edit | 可选title、notes、deadline；deadline省略表示保留，null表示明确清空 | 桌面复用ProductivityAction::Task，保留计划、跟进、等待说明与标签；手机按原实体合并，只改指定字段，保留desktop与未知字段 |
| status | todo/in_progress/completed | 桌面复用原Status事务；手机复用workspaceCommand。完成/重开处理等待标记及完成事实，拒绝过期任务集合 |
| move | projectId或null；带子树需confirmDescendants | 桌面复用Move，手机在一次事务中更新原任务及子树；保留任务ID及父子关系，检查任务集合和项目版本。跨项目依赖需先走原兼容入口处理 |

需要一并重开已结束父任务/项目的操作仍使用已有明确确认路径，新简化命令直接提示处理，不暗中重开关联资料。新模块不承接新建、软删除/恢复或10秒撤销的界面流程，这些在P1中接入；已有相关能力继续使用原命令。

每次变更在提交前固定操作ID、发生时刻、任务ID、本地编辑版本及完整命令。结果不明时保留原命令，重试原内容；同一任务的不同意图先被阻止，不能将上次操作重新编号。明确版本/业务拒绝后才能重新读取和构建命令。当前冻结状态保存在调用进程中；跨重启的通用表单恢复不在本阶段新增，已有同步队列、AI持久草稿和回执保留。

桌面沿用账号选库与原生事务、outbox重放。手机命令在原事务内检查工作空间、任务版本集合、项目版本集合，再应用变更；重放检查在版本集合检查之前，避免已提交但回包丢失时误判。新增预览字段仅用于本地命令，不增加同步协议或数据库结构版本。

## 已接入与后续页面

桌面现有 `readWork` 通过共同读取模块获取任务，原有每日准备仍在该旧入口执行；新的 `personalTasks.read()` 本身不执行每日准备。手机任务行使用共同状态与typed截止投影，原日历的安排筛选继续保留。项目详情进度复用共同统计函数。

共同查询/变更模块已可调用并有双适配验证。默认个人待办首页、短项目表单、连续录入、三态界面、删除恢复与撤销反馈按P1分项实现；成长XP与新AI流程仍按P2/P3执行。

测试与实际结果见[实施记录](implementation-p0-03.md)。
