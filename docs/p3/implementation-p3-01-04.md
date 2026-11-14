# P3 个人行动助手实施与针对性验证

日期：2026-11-12（Asia/Hong_Kong）。

本记录覆盖P3-01至P3-04的代码与针对性验证；整体页面、安装包、真实双端旅程与恢复验收由父任务在P4统一归档。未修改真实个人数据库，未部署服务。

## 个人核心入口

新增[PersonalAgentPanel](../../apps/client/src/PersonalAgentPanel.tsx)，核心路径只保留两种模式：

- `mode="decompose" projectId={id}`：读取已有个人项目的目标和真实任务，生成平铺草稿。用户可修改标题、说明、可选截止，取消勾选不需要的项，一次确认创建。默认提示3至7项，沿用原最多8项的有限协议，不配置成员、估时、依赖或奖励。
- `mode="next"`：在个人待办读取全部个人项目及独立任务；传`projectId`则只读取该项目。程序计算任务数量、完成、逾期和旧树形有效叶子进度，提供最多三项明确标识的“系统建议”。可选调用AI解释已有下一步；模型结果另标“AI解释”，没有创建、采用、改状态或改日期入口。

父页面接入属性为`mode`、可选`projectId`、`onClose`、可选`onApplied(receipt)`及`onOpenTask(id)`。原[AiPlannerPanel](../../apps/client/src/AiPlannerPanel.tsx)与旧规划草稿、奖励配置、依赖和估时保持兼容访问。

新组件使用独立的`praxis-personal-agent-v1`缓存，按服务/账号/数据库/工作空间的可信scope、项目和模式隔离。开始新一轮前保存上轮记录，不删除原高级助手的v1草稿。当前设备采用草稿，正式任务正常使用原同步路径。

## 上下文和模型边界

[领域构建器](../../apps/client/src/personal-agent-model.ts)复用共同个人查询计算事实，[存储适配](../../apps/client/src/personal-agent-storage.ts)通过真实个人快照与原项目任务元数据读取版本、前置和每日安排，并在构建前再次检查scope和项目版本。文本不携带凭据，也不能授予权限。

系统候选排除父任务摘要、已完成、取消、阻塞、等待、未完成前置、未来安排及已结束/归档项目，并以逾期、进行中等程序规则排序。模型只可引用程序给出的最多三个候选ID；这些ID仍须存在于本次实际任务上下文。没有可执行任务时可以没有建议。

事实统计覆盖当前范围全部任务，模型上下文最多100项，超出时明确提示截断并建议进入项目缩小范围。若一个项目本身超过100项已有任务，直接禁用新的AI拆解与采用，明确提示安全读取边界、手动管理或拆分项目，不把这一规模限制伪装成过期版本；已存在的未知采用仍可核对原回执。程序事实与系统排序均明确标识，不伪装成模型结果；旧缓存的AI解释如果基于较早快照会显示提示。页面显示实际读取时间与任务来源。

[服务协议](../../apps/api/src/ai-contract.ts)增加可选个人上下文和可选草稿说明/截止字段，原字段及旧调用仍有效。旧客户端请求生成时不返回新的任务字段，旧草稿与回执缺省序列化保持原形状。新核心请求不接受依赖、估时、奖励；只读模式的模型结果若包含新任务会被拒绝。

## 一次确认、失败与恢复

新草稿在确认前只保存在当前设备，不写正式任务、进度或经验。确认前重新读取并比对项目、任务版本、时区和日期；真正采用继续使用原桌面`ai_apply`或手机`workspaceCommand`原子事务及完整业务校验。

- 确认前将完整采用命令、稳定操作ID和任务ID持久化。持久化失败则不发送生成/业务写入，输入保留在面板。
- 恢复待确认记录时按原预览重算完整命令，除操作ID外须与项目、请求、run及所选任务完全对应；不匹配的原raw记录保留，但不执行采用。查询回执返回后、写入前、接受结果前再次校验scope，回执的项目和任务ID也须与原命令一致。
- 采用和重试先查询原回执，回执存在直接显示原结果，未知结果不生成第二个操作。关闭/重开面板仍可核对原命令；自身成功写入导致资料版本变化时也不会把原回执核对按钮锁死。
- 明确业务拒绝不覆盖任务，草稿保留。账号或工作空间变化时保留原标识，要求返回原scope核对，不能把其他scope的缺失回执当作原操作没有发生。
- 生成使用固定请求ID，未知结果提供查询原生成、重试原请求和停止。自动轮询有上限，服务已有超时、有限工具循环和取消边界。
- 面板始终可以关闭，AI不可用不阻塞手动任务管理。未配置、登录失效、离线、失败、取消、待确认和已采用分别反馈。

桌面[AiTask存储](../../apps/desktop/src-tauri/src/store/ai.rs)为可选说明/日期增加向后兼容解析，不新增数据库迁移。日期写入原typed日期字段，不制造每日安排。手机[采用适配](../../apps/client/src/ai-mobile-adapter.ts)同样写入原任务实体和typed日期扩展。原采用撤销、历史输入、旧奖励和原回执继续保留。

## 针对性验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 类型检查 | 通过 | [typecheck.txt](../evidence/p3-2026-11-12/typecheck.txt) |
| AI组合TypeScript回归 | 7个文件、76项通过；新增12项 | [typescript-ai.txt](../evidence/p3-2026-11-12/typescript-ai.txt) |
| 原生AI事务回归 | 6项通过；新增说明/日期、原回执防重、撤销与非法日期检查 | [native-ai.txt](../evidence/p3-2026-11-12/native-ai.txt) |
| 真实模型个人拆解 | DeepSeek `deepseek-flash`，ready，5项平铺任务，说明/可选日期字段有效，无估时/依赖/奖励 | [live-model.json](../evidence/p3-2026-11-12/live-model.json) |
| 真实模型个人待办只读 | ready，0项新任务，准确引用合成上下文中可执行的已有任务 | [live-model.json](../evidence/p3-2026-11-12/live-model.json) |

新增领域与服务用例覆盖实际统计、最多三项候选、范围/版本、关闭项目的只读恢复、删减编辑、稳定待确认命令、禁止只读采用、目标变化、scope隔离、认证与账号隔离、重复生成防重、模型越界新任务拒绝，以及真实手机SQLite采用说明/日期和回执防重。补充101项项目的安全边界、恢复命令篡改拒绝和receipt/apply之间切换scope的真实异步race用例。本次76项组合回归同时验证旧草稿和高级AI路径继续有效。

真实模型通过[个人模型验证脚本](../../scripts/personal-agent-live-smoke.mjs)使用已配置环境凭据，仅向提供商发送合成目标与合成任务。服务数据库为独立内存库，没有写业务任务；证据不包含密钥、真实账号内容或完整模型原文。两例均通过真实网络调用，不是模型替身。这不代替真实客户端界面、设备采用或网络同步证据。

## 复跑

```powershell
pnpm.cmd typecheck
pnpm.cmd exec vitest run apps/api/src/ai.test.ts apps/api/src/ai-provider.test.ts apps/api/src/ai-recovery.test.ts apps/api/src/ai-personal.test.ts apps/client/src/ai-planner-model.test.ts apps/client/src/ai-mobile-adapter.test.ts apps/client/src/personal-agent-model.test.ts
. ./scripts/native-env.ps1
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --test ai
pnpm.cmd --filter @praxis/api build
node scripts/personal-agent-live-smoke.mjs
```

只有最后一条调用真实模型，使用既有服务环境的凭据。父任务负责最终全量回归、58组既有页面回归及新增界面旅程，并按实际证据更新P3/P4总任务清单。
