# P1-01 个人待办首页实施与验证

日期：2026-11-11  
结果：P1-01完成；当前18项任务中4项完成，14项待执行。  
需求：[个人版PRD](../prd-mvp-v0.1.md)、[当前计划](../mvp-development-plan-2026-11-09.md)。

## 本次交付

桌面与手机默认打开“我的待办”，使用同一份[首页模块](../../apps/client/src/PersonalTodoHome.tsx)和P0共同个人查询。任务覆盖当前账号全部个人项目与独立任务，不要求先加入今日，不要求设置截止日期。

- 按逾期、今天、之后、无日期排列，空分组隐藏。组内沿用截止日、创建时刻和任务ID的稳定排序；时间变化时重新计算分组。
- 已完成默认折叠，可展开后重新打开任务；已取消、已删除不进入未完成分组。历史未知完成日期保持未知。
- 任务行显示标题、状态、可选截止与项目名称；独立任务明确标识。旧等待、阻塞及层级保留标识；旧确定时刻继续按原显示时区展示。
- 点击标题打开既有任务详情/编辑，点击项目回到原项目上下文。快捷完成和重开复用原个人变更命令，不复制任务或重新编号。
- 桌面原“今日与近期”、搜索、收件箱、项目、修炼和设置继续可达；手机原任务清单保留在菜单，日历及其他功能保留。手机在首页新建任务时可不安排日期，既有按日录入行为不变。
- 首页采用现有明暗主题和语义颜色。保持任务列表为主体，本阶段未提前增加新的XP、等级或AI流程。

新增[首页样式](../../apps/client/src/personal-todo.css)与旧桌面侧栏布局适配，避免复用旧编辑区的通用按钮样式。手机首页只显示待办内容，修正了新入口被旧条件误识别为设置页面的问题。

## 保存与读取反馈

读取中显示状态，失败显示重新读取；已有快照保留并标记为上次读取，暂停基于旧版本继续修改。首次读取失败不会显示成“没有任务”。

完成/重开等待确认后刷新。已提交但刷新失败只提供重新读取，不重复提交。结果不明时保留原base、任务ID、操作ID、目标状态及命令，提供“重试原操作”，同时阻止其他修改和页面内导航。明确版本或业务拒绝通过 `PersonalTaskRejectedError` 区分，允许重新读取后操作。

同步、应用回到前台、任务编辑结束及手动刷新会读取新快照；编辑中和待确认期间避免自动读取替换操作基础。原桌面每日准备流程在首页读取前保留，P0的底层 `personalTasks.read()` 仍保持原接口。

这次没有增加数据库结构或迁移脚本，没有更换owner、删除历史或清理同步队列。旧修炼、奖励、AI草稿与回执继续使用原存储。

## 验证结果

| 检查 | 本次结果 | 证据 |
| --- | --- | --- |
| 类型检查 | 通过，exit 0 | [typecheck.log](../evidence/p1-01-2026-11-11/typecheck.log) |
| 完整TypeScript回归 | 49个文件、285项通过；原适配用例补强明确拒绝类型检查 | [typescript.log](../evidence/p1-01-2026-11-11/typescript.log) |
| 原生针对性回归 | 11项通过：完成/撤销、旧库升级、整库备份恢复、个人查询与实体同步 | [native-compatibility.log](../evidence/p1-01-2026-11-11/native-compatibility.log) |
| 双端界面回归 | 14组通过，无页面运行异常；桌面1280×900、手机390×844布局无横向溢出 | [ui-results.json](../evidence/p1-01-2026-11-11/ui-results.json) |
| 客户端及API构建 | 均通过，exit 0；客户端仍有大chunk及混合导入提示 | [客户端](../evidence/p1-01-2026-11-11/client-build.log)、[API](../evidence/p1-01-2026-11-11/api-build.log) |
| 原文件保护 | 核对实施前538个文件，仅本次列明的模块和计划改变；原生生产源码与迁移脚本无变化 | [results.json](../evidence/p1-01-2026-11-11/results.json) |

14组界面检查分别覆盖两端的默认首页及四分组、完成/重开、未知结果重试、过期版本拒绝、提交后读取失败、任务/项目/原每日页面往返，以及账号作用域替换和空状态。样本包括两个个人项目、未安排任务、独立任务、旧等待/阻塞、确定时刻、未知历史完成日期、取消和删除内容。

界面检查在无头Edge/Chromium中运行真实App、MobileApp及共同个人模块，原生桥接和Capacitor使用合成替身；没有连接真实账号服务。它验证页面接入和反馈，不代替实际Windows/Android安装验收。真实SQLite/Store能力分别由本次原生11项及完整TypeScript中的手机存储、账号隔离测试验证。

截图已视查，并覆盖暗色及减少动效环境：[桌面浅色](../evidence/p1-01-2026-11-11/desktop-home.png)、[桌面暗色](../evidence/p1-01-2026-11-11/desktop-home-dark.png)、[手机浅色](../evidence/p1-01-2026-11-11/mobile-home.png)、[手机暗色](../evidence/p1-01-2026-11-11/mobile-home-dark.png)。

## 复跑

```powershell
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd --filter @praxis/client build
pnpm.cmd --filter @praxis/api build
. ./scripts/native-env.ps1
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --test personal_compatibility --test personal_queries --test m0_baseline --test completion
node scripts/personal-todo-smoke.mjs
```

[界面验证脚本](../../scripts/personal-todo-smoke.mjs)在本机临时启动Vite与隔离浏览器配置，仅载入[合成样本桥接](../../scripts/fixtures/personal-todo-browser.mjs)，使用独立的 `.scratch/p1-01-vite-cache` 缓存。Windows默认使用已安装Edge，可用 `PRAXIS_TEST_BROWSER_CHANNEL` 选择其他已安装的Playwright通道。原文件哈希清单位于 `.scratch/p1-01-baseline/pre-existing-files.json`。

## 验收边界和下一步

P-AC03/P-AC08的首页身份和覆盖范围已有数据与界面证据；P-AC13的账号隔离存储回归继续通过，界面替身也覆盖作用域替换。真实双端同步、安装包及完整设备旅程仍由P4执行。此次没有操作真实用户库、发布部署或连接真实AI模型。

下一项为 **P1-02 精简项目创建和列表**。连续录入、中文输入法保护、完整三态行内编辑在P1-03；删除恢复和10秒撤销在P1-04；最终导航与手机一致性在P1-05。本阶段保留这些既有能力的原入口，没有提前勾选后续任务。
