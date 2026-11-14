# P1-03 行内任务闭环实施与验证

完成日期：2026-11-12（香港时间，2026-11-11开始实施）。  
结果：P1-03完成；18项个人任务中6项完成、12项待执行。  
需求：[个人版PRD](../prd-mvp-v0.1.md)、[当前计划](../mvp-development-plan-2026-11-09.md)。

## 核心流程与页面

桌面和手机的个人待办首页、项目详情共用[任务页面](../../apps/client/src/PersonalTodoHome.tsx)。首页新建独立任务，项目内新建默认归属当前项目；新任务为待办，不要求先安排到今日。所有新核心操作不显示负责人、成员或分派配置。

| 流程 | 用户操作 | 系统反馈 |
| --- | --- | --- |
| 连续录入 | 输入标题，按Enter或点击添加；需要时展开“说明与截止日期（可选）” | 确认保存并读取后清空本项全部字段，焦点返回标题，可继续输入下一项；不以标题匹配或复制旧任务 |
| 中文组词 | 组词时用Enter确认候选字 | 组合输入期间、组合结束紧随的提交和keyCode 229不触发录入；之后明确按Enter才保存 |
| 三态操作 | 任务行选择待办、进行中、已完成；也可继续使用圆形快捷完成/重开 | 确认后更新同一任务，已完成进入折叠区；重开返回未完成分组，各视图读取同一身份与状态 |
| 行内修改 | 点击行内“编辑”，修改标题、说明或可选截止日期，保存 | 原地显示保存结果；未改变的字段不主动覆盖，版本过期拒绝写入并保留输入 |
| 查看原资料 | 点击任务标题，或打开原任务入口 | 打开原桌面任务面板、手机完整编辑器；树形、排序、看板、甘特图和原录入方式继续可达 |

[共同录入组件](../../apps/client/src/PersonalTaskComposer.tsx)保留非空草稿，防止页面内导航和其他任务修改打断；可以主动清空草稿。说明中的Enter保留换行。新标题使用双端可接受的500个Unicode字符上限；输入错误不发送写入。

[中文输入保护](../../apps/client/src/useImeSubmit.ts)结合组合输入状态、原生`isComposing`、keyCode 229和组合结束后的50毫秒保护窗口，覆盖新的行内录入及行内标题编辑。界面自动化使用组合事件验证这一客户端行为；实际Windows输入法、Android WebView与软键盘仍在P4验证，不将合成事件等同于真机验收。

## 保留旧内容与操作安全

[共同个人任务接口](../../packages/application/src/personal-tasks.ts)新增`create(base, draft)`。调用方为当前一项草稿提供稳定任务ID；接口冻结完整原生/工作空间命令、操作ID及发生时刻，复用现有事务和回执。下一项使用新ID，同标题也允许表示不同任务。

- 未知保存结果：冻结原输入，提供“重试原操作”，不允许改动待确认内容或清空草稿。返回原账号/工作空间后才处理原回执；切换作用域的拒绝不能清除先前未知结果，避免再次创建。
- 已保存、随后读取失败：明确提示任务已保存，后续只重新读取，不重复发送创建命令。新快照已包含原任务时，仍能通过原回执完成未知结果重试。
- 明确拒绝：创建表单保留可编辑草稿，可主动重新读取并保留草稿。行内编辑保留当前输入、阻止旧版本继续覆盖；取消后重新读取最新内容，再核对修改。不会自动把旧草稿覆盖到新版本。
- 新建项目任务时再次检查项目可用性。手机在原事务中检查工作空间与项目版本；桌面补充事务内新建任务的活动项目检查，阻止项目结束后并发添加。已有结束项目的任务说明仍可编辑。
- 三态、编辑和新建使用回传的本地版本，不假设两端版本递增次数相同。保留原状态变更、完成历史、修炼与奖励规则。

[行内编辑组件](../../apps/client/src/PersonalTaskInlineEditor.tsx)及[字段变更构建](../../apps/client/src/personal-task-editor.ts)只提交用户明确改变的基本字段。旧精确截止时刻及显示时区在修改标题/说明时保持原样；点击“修改截止日期”才显式转换为日期，即使选择同一天也属于明确替换。清除截止不会清除每日安排、项目目标日期或其他旧时间字段。

旧等待、阻塞、取消及层级不批量转换成三态。旧等待/阻塞在任务行保留标识，只有用户选择三态时才进行原业务变更；需要连带重开父任务/项目的情况继续走原确认入口。

编辑或待确认时延后同步快照和定时分组变化，避免任务跨日期分组时重新挂载并清空草稿。桌面项目回到前台也使用可延后的同步读取。手机行内编辑期间隐藏浮动新建按钮，避免遮挡输入；未知行内保存结果在任务行内提供重试。

桌面“层级与排序”、原看板/甘特图、任务属性面板、项目高级设置保留；手机“原层级任务与录入”、分区及完整编辑器保留。现有收件箱、日历、每日安排、修炼、AI、账号、同账号同步及备份未删除。没有新增迁移、修改schema版本、清理队列或操作真实用户数据库。

## 验证结果

本次跨日执行，证据继续按实施起始日保存在`docs/evidence/p1-03-2026-11-11/`。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 类型检查 | 通过，exit 0 | [typecheck.txt](../evidence/p1-03-2026-11-11/typecheck.txt) |
| 完整TypeScript回归 | 52个文件、301项通过；新增7项 | [typescript-tests.txt](../evidence/p1-03-2026-11-11/typescript-tests.txt) |
| 原生完整回归 | 182项通过；新增2项 | [native-tests.txt](../evidence/p1-03-2026-11-11/native-tests.txt) |
| 行内双端界面 | 28组通过，无页面运行异常 | [ui-results.json](../evidence/p1-03-2026-11-11/ui-results.json) |
| 既有待办与项目界面 | 14组待办、16组项目检查通过 | [待办](../evidence/p1-03-2026-11-11/todo-regression/ui-results.json)、[项目](../evidence/p1-03-2026-11-11/project-regression/ui-results.json) |
| 客户端与API构建 | 均通过；客户端仍有原大chunk与混合导入提示 | [客户端](../evidence/p1-03-2026-11-11/client-build.txt)、[API](../evidence/p1-03-2026-11-11/api-build.txt) |
| 原文件保护 | 核对实施前555个文件，无文件缺失或意外改动，迁移文件保持原样 | [results.json](../evidence/p1-03-2026-11-11/results.json) |

新增TypeScript用例使用真实手机SQLite验证独立/项目创建、防重回执、项目并发变化、三态和扩展字段保留；桌面适配用例验证冻结后的创建字段及未知回执跨账号保护。行内字段用例验证旧时刻不变、同日显式替换、清除与非法输入。新增原生用例覆盖不安排今日的创建、原回执、说明、三态、旧时刻保留，以及结束项目的新建拒绝和旧任务编辑。完整原生回归继续覆盖迁移、备份、账号隔离、同步、AI和修炼等原能力。

界面检查逐端覆盖组合回车、组合结束紧随提交、229、连续输入焦点、说明换行、可选截止、三态/重开、行内修改、未知结果本地重试、旧精确时刻和等待状态、并发编辑、创建失败保留输入、提交后读取失败、项目/首页一致性与旧入口。受控浏览器时钟还验证跨过日期边界时草稿不丢失。

截图已视查，覆盖明暗主题、减少动效、桌面1280×900和手机390×844，无横向溢出：[桌面](../evidence/p1-03-2026-11-11/desktop-inline-light.png)、[手机](../evidence/p1-03-2026-11-11/mobile-inline-light.png)、[手机行内编辑](../evidence/p1-03-2026-11-11/mobile-inline-editor.png)。编辑区可滚动；实际软键盘布局仍属P4设备验收。

界面验证运行真实React页面与共同模块，原生桥接、账号服务和Capacitor使用隔离合成替身。它验证页面接入和反馈，不代替实际Windows/Android安装与网络同步。真实存储行为分别由SQLite与原生Store测试验证。初次运行的诊断保存在`initial-attempts`；最终结果以上表通过记录为准。

## 复跑与后续

```powershell
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd --filter @praxis/client build
pnpm.cmd --filter @praxis/api build
. ./scripts/native-env.ps1
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
node scripts/personal-inline-smoke.mjs
$env:PRAXIS_UI_SCENARIO=''
$env:PRAXIS_UI_EVIDENCE='docs/evidence/p1-03-2026-11-11/todo-regression'
node scripts/personal-todo-smoke.mjs
$env:PRAXIS_UI_SCENARIO='projects'
$env:PRAXIS_UI_EVIDENCE='docs/evidence/p1-03-2026-11-11/project-regression'
node scripts/personal-todo-smoke.mjs
```

[行内验证脚本](../../scripts/personal-inline-smoke.mjs)复用隔离Vite/Edge启动和合成桥接，场景位于[行内任务旅程](../../scripts/fixtures/personal-inline-scenario.mjs)，受控时钟仅用于测试入口。生产入口没有测试开关。原文件哈希清单位于`.scratch/p1-03-baseline/pre-existing-files.json`。

P-AC02的客户端事件保护、P-AC04的三态与版本保护已有本阶段证据。下一项为 **P1-04 统一进度和恢复反馈**：删除、恢复、10秒撤销及相关版本检查；P-AC04的完整撤销语义不提前宣称完成。最终双端导航在P1-05，实际输入法、安装包及网络同步在P4。
