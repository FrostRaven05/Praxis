# P1-05 手机与桌面一致体验实施记录

日期：2026-11-12（Asia/Hong_Kong）。范围：个人管理首版的应用接线、页面承载、保存与同步反馈，以及成长和行动助手入口。需求依据：[个人版PRD](../prd-mvp-v0.1.md)、[开发计划](../mvp-development-plan-2026-11-09.md)。

双端接线及86组浏览器回归已完成；当前实际Windows/Android隔离运行验收也已有7组通过的原始证据。完整首版验收结论和未覆盖项统一见[P4验收记录](../p4/personal-mvp-acceptance-2026-11-12.md)，本记录不将构建或浏览器桥接测试等同于全部设备验收。

## 核心页面与导航

| 场景 | 桌面 | 手机 | 共同行为 |
| --- | --- | --- | --- |
| 两个主导航 | 左侧主导航仅“我的待办”“项目” | 底部主导航仅“待办”“项目” | 默认进入个人待办；主导航使用明确标签和当前页状态 |
| 我的待办 | 主内容区展示共同首页 | 相同业务组件嵌入手机壳 | 覆盖全部个人项目和独立任务，按逾期、今天、之后、无日期分组；已完成折叠 |
| 项目列表 | 共同简表单及项目列表 | 同口径列表与创建表单 | 创建后进入详情；空项目、完成数量、比例与逾期口径一致 |
| 项目详情 | 项目概览、任务列表与原高级入口 | 项目概览及同一核心任务列表 | 行内添加、三态、说明、可选截止、删除恢复和10秒撤销复用共同能力 |
| 任务详情 | 原任务属性以右侧栏承载，项目原任务面板继续可达 | 小屏原编辑对话框全屏承载 | 核心字段与原属性共存；保留任务ID、旧层级和扩展字段 |
| 行动助手 | 独立对话面板，保留原AI高级入口 | 小屏全屏面板 | 首页打开下一步建议；项目可打开拆解或项目下一步建议；关闭后返回原上下文 |

入口实现见[App](../../apps/client/src/App.tsx)、[MobileApp](../../apps/client/src/mobile/MobileApp.tsx)。任务与面板样式见[task-editor.css](../../apps/client/src/task-editor.css)、[personal-shell.css](../../apps/client/src/personal-shell.css)、[personal-agent.css](../../apps/client/src/personal-agent.css)。手机非快捷输入编辑对话框在700px及以下全屏；行动助手在600px及以下全屏。快捷任务录入仍保留原轻量输入形态。

页面内容复用[PersonalTodoHome](../../apps/client/src/PersonalTodoHome.tsx)及共同个人任务查询，不另建手机任务数据集或团队概念。任务输入、版本冲突、中文组词保护和旧精确日期的处理沿用[P1-03](implementation-p1-03.md)；进度、软删除、恢复和撤销沿用[P1-04](implementation-p1-04.md)。

## 兼容入口与导航保护

桌面“更多个人功能”容纳搜索、今日与近期、收件箱和旧修炼成长；项目快捷入口、设置和同步状态继续保留。原任务详情、树形/排序及项目高级视图仍可进入，不以新平铺核心页替换或删除旧内容。

手机[侧边菜单](../../apps/client/src/mobile/MobileDrawer.tsx)保留任务清单、日历、收件箱、项目快捷入口、习惯、重复任务、专注、记录、回顾、策略与决策、搜索与筛选、数据复盘、回收站和设置。项目“原层级任务与录入”“原高级AI工具”明确收纳原复杂路径。菜单打开时锁定底层滚动，关闭后恢复触发按钮焦点。

编辑草稿、写入中及待核对结果使用共同忙碌状态保护导航，避免切换页面丢输入或向错误作用域写入。同步刷新与时间分组变化在草稿处理结束后再应用。手机从助手建议打开原任务时，先关闭助手，再打开详情，避免旧闭包的导航锁阻断。助手停止、失败或关闭后仍可返回手动任务路径。

## 保存与同步反馈

- 本地操作区分提交中、已确认、明确拒绝、结果未知，以及已确认写入但读取失败。明确拒绝保留输入；结果未知保留原操作ID和命令供核对/安全重试；已写入但读取失败仅重新读取。不同状态不会统一显示为“保存成功”。
- 版本或账号/工作空间变化时拒绝覆盖新内容，保留可恢复的原输入。状态、删除、恢复与撤销均复用原稳定回执和事务，不新增另一条写入通道。
- 桌面继续使用[LanSyncStatus](../../apps/client/src/LanSyncStatus.tsx)，显示连接状态、待上传和冲突数；有冲突可进入原处理面板。状态查询失败会提示“同步状态暂不可用，本机操作不受影响”。
- 手机继续使用[LanSyncPanel](../../apps/client/src/mobile/LanSyncPanel.tsx)的同步、最近成功、待上传、冲突及恢复路径，联网、应用恢复和同步成功后刷新共同内容。本地保存与远端同步分别反馈，不将离线保存表述为跨端同步完成。

这些入口使用原账号与工作空间作用域；本阶段没有清理旧库、强制转换旧任务或改写历史数据。

## 成长与行动助手接入

[个人成长条](../../apps/client/src/PersonalGrowthStrip.tsx)只放在个人待办首页，两端展示同一任务事实派生的等级、经验条、总XP和今日完成数。每个有效完成任务10 XP，每100 XP升级；重开、删除、恢复和撤销按同一任务身份调整贡献。未知历史完成时间可贡献总XP，但不制造“今天完成”。不增加领奖步骤，旧修炼和奖励历史分开保留。

成长可隐藏，也可减少动效；系统减少动效偏好同样生效。偏好按个人作用域保存在当前设备，无法保存时提示仅在本页生效，任务录入和经验计算仍可使用。规则与兼容边界见[P2实施记录](../p2/implementation-personal-growth.md)。

[PersonalAgentPanel](../../apps/client/src/PersonalAgentPanel.tsx)通过`mode="decompose" | "next"`及可选`projectId`接入，采用后刷新原项目和同步视图。拆解仅生成可编辑、可删减的平铺草稿，一次确认后创建正式任务；超过100项任务的项目明确限制新拆解，仍可查看只读事实及核对原未知回执。下一步建议展示来源、读取时间及程序统计，最多三项明确标识的“系统建议”；可选模型结果另标“AI解释”，不会改任务状态或日期。

没有AI配置或调用失败时，用户仍可查看只读事实、关闭助手并手动管理任务。旧规划草稿、奖励、依赖和估时保留在原高级路径。作用域、版本、草稿恢复与回执防重详见[P3实施记录](../p3/implementation-p3-01-04.md)。

## 验证结果与边界

| 检查 | 当前结果 | 证据 |
| --- | --- | --- |
| TypeScript类型检查 | 通过 | [日志](../evidence/remaining-mvp-2026-11-12/typecheck.txt) |
| TypeScript回归 | 57个文件、329项通过 | [日志](../evidence/remaining-mvp-2026-11-12/typescript-tests.txt) |
| Rust原生回归 | 185项通过 | [日志](../evidence/remaining-mvp-2026-11-12/native-tests.txt) |
| 客户端与API构建 | 通过 | [客户端](../evidence/remaining-mvp-2026-11-12/client-build.txt)、[API](../evidence/remaining-mvp-2026-11-12/api-build.txt) |
| Windows与Android构建 | 通过 | [Windows](../evidence/remaining-mvp-2026-11-12/desktop-build.txt)、[Android](../evidence/remaining-mvp-2026-11-12/android-build.txt) |
| 完整App/MobileApp浏览器回归 | 待办14、项目16、行内28、整合28，合计86组通过，运行异常为0 | [汇总](../evidence/remaining-mvp-2026-11-12/browser/browser-regression-results.json)、[范围说明](../evidence/remaining-mvp-2026-11-12/browser/README.md) |
| 实际原生整合旅程 | 7组通过，`errors: []`；仅合成验收数据 | [原始结果](../evidence/remaining-mvp-2026-11-12/native/results.json)、[P4验收记录](../p4/personal-mvp-acceptance-2026-11-12.md) |

浏览器回归加载真实React页面，但原生、账号、同步与模型使用隔离合成桥接。覆盖双主导航、三个核心页面、原高级入口、成长隐藏与减少动效、未知结果重试、删除恢复及小屏明暗主题；它不能单独证明真实设备和网络可用。截图：[桌面浅色](../evidence/remaining-mvp-2026-11-12/browser/desktop-remaining-light.png)、[桌面暗色](../evidence/remaining-mvp-2026-11-12/browser/desktop-remaining-dark.png)、[手机浅色](../evidence/remaining-mvp-2026-11-12/browser/mobile-remaining-light.png)、[手机暗色](../evidence/remaining-mvp-2026-11-12/browser/mobile-remaining-dark.png)。

实际原生7组使用真实Tauri WebView2和独立Android 17/API 37模拟器包、本地HTTPS账号/实体服务及已配置模型，覆盖启动导航、任务进度和XP、备份恢复、同ID跨端同步、断网重连、草稿一次确认采用与只读建议，以及重启和第二账号隔离。实体手机、系统中文输入法候选选择/手写尚未覆盖；已有composition事件自动化不替代该项人工设备验收。最终范围与剩余限制以P4记录为准。

本次仅补充实施文档，以上测试为主任务已有执行证据，不因文档新增而重复运行生产测试。总计划的勾选及首版验收结论由主任务统一更新。
