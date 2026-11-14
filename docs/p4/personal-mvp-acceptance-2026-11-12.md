# 个人首版整体验收与交付记录

日期：2026-11-12，Asia/Hong_Kong。依据：[个人版 PRD v0.2](../prd-mvp-v0.1.md)、[开发计划](../mvp-development-plan-2026-11-09.md)。

P1-04 至 P4-03 已实施并完成本轮验收，个人版计划共18项完成。Android 按用户明确选择使用实际运行的隔离模拟器；下文区分规则、浏览器与实际客户端证据。未修改真实用户数据库，未安装覆盖原手机应用，未部署生产服务。

## 交付行为

- 两个主导航“我的待办 / 项目”，保留三个核心页面。旧搜索、今日安排、收件箱、修炼、回收站及高级项目/AI功能继续通过次级入口访问。
- 任务完成、进行中、重开、软删除和恢复影响同一身份的进度与经验；10秒撤销检查原操作后版本，拒绝覆盖新编辑。旧父子任务和复杂删除恢复使用原兼容路径。
- 首页提供每项有效完成10 XP、每100 XP一级的轻量成长，重开/删除回退，恢复还原。未知完成时间不算作今天，旧修为和领奖历史独立保留。支持隐藏和减少动效。
- 行动助手可将个人项目目标拆成可编辑草稿，一次确认采用；下一步模式显示真实统计和最多三项系统建议，可请求模型解释，保持任务只读。保留原草稿、回执、失败输入及范围/版本检查。
- 本轮为AI目标、任务标题、说明和日期补齐稳定的可访问名称，实际 WebView 可以准确定位和编辑。

详细实现：[P1-04](../p1/implementation-p1-04.md)、[P1-05](../p1/implementation-p1-05.md)、[P2成长](../p2/implementation-personal-growth.md)、[P3行动助手](../p3/implementation-p3-01-04.md)。

## 验证层次与结果

| 层次 | 结果 | 证据 |
| --- | --- | --- |
| 类型检查 | 最终源码通过 | [typecheck.txt](../evidence/remaining-mvp-2026-11-12/typecheck.txt) |
| TypeScript完整回归 | 57个文件、329项通过，较本轮前新增28项 | [日志](../evidence/remaining-mvp-2026-11-12/typescript-tests.txt) |
| Rust完整回归 | 185项通过，较本轮前新增3项；包含旧存储、同步、备份、AI和回收站 | [日志](../evidence/remaining-mvp-2026-11-12/native-tests.txt) |
| 完整App浏览器回归 | 双端86组、页面异常0：待办14、项目16、行内28、本轮整合28 | [汇总](../evidence/remaining-mvp-2026-11-12/browser/browser-regression-results.json) |
| 成长独立组件 | 双端12组通过；含隐藏恢复、减少动效、偏好隔离及写入失败 | [结果](../evidence/p2-2026-11-12/component-ui-results.json) |
| 真实模型独立验证 | DeepSeek `deepseek-flash` 两项能力均ready；拆解5项平铺草稿，只读0项新任务 | [结果](../evidence/p3-2026-11-12/live-model.json) |
| 实际Windows与Android | 7组完整旅程通过，页面异常0；含真实网络与真实模型 | [结果](../evidence/remaining-mvp-2026-11-12/native/results.json)、[运行日志](../evidence/remaining-mvp-2026-11-12/native-run.txt) |
| 构建 | 客户端、API、Windows原生与Android隔离QA包均通过 | [客户端](../evidence/remaining-mvp-2026-11-12/client-build.txt)、[API](../evidence/remaining-mvp-2026-11-12/api-build.txt)、[Windows](../evidence/remaining-mvp-2026-11-12/desktop-build.txt)、[Android](../evidence/remaining-mvp-2026-11-12/android-build.txt) |

上述测试数量分别代表不同层次，不能相加称作设备验收数量。完整回归与86组页面检查后仅补齐四个AI表单的ARIA名称；最终源码重新类型检查、重新构建Windows与Android，并用实际客户端通过以下全部旅程。

## 实际客户端旅程

环境为真实 Tauri/WebView2 Windows程序与 Android 17 / API 37 x86_64 模拟器 `Praxis_P4`，设备序列 `emulator-5560`；手机包名固定 `com.praxis.mobile.qa`。API使用项目内的临时HTTPS服务、合成账号和独立SQLite；模型使用已配置的真实提供商。服务CA只导入测试应用连接配置，没有修改系统信任库或放开明文网络。

1. 启动两端，核对主导航和空白访客库，确认实际Android包名。
2. Windows只填名称创建项目，行内添加中文任务，完成后项目100%、10 XP；删除后0 XP，10秒内撤销后同一ID和原完成状态恢复为10 XP。
3. 使用实际设置页创建手动备份，新增临时任务，再验证备份副本并重启恢复：原任务ID与完成事实保留，备份后的临时内容不混入恢复库。
4. Windows注册合成账号A、Android登录A；访客内容与账号A隔离。Windows新建项目/任务，Android收到同一ID；Android改为进行中、再完成，Windows收到同一状态并显示10 XP。
5. 关闭实际HTTPS服务，Android离线新增独立任务，本地保存且Windows尚无该项；恢复服务后Windows收到同一ID且只有一份。
6. Windows调用真实模型生成草稿，确认前正式任务数不变；仅勾选一项并修改标题、说明和截止，一次确认创建一项，Android收到全部编辑字段。Android请求真实AI解释下一步，无创建入口，前后全部正式任务ID/版本不变。
7. 强制停止并重新打开Android应用，账号A任务保留；退出后注册账号B看不到A任务，再切回A恢复原任务。

最终截图：[Windows](../evidence/remaining-mvp-2026-11-12/native/desktop-final.png)、[Android](../evidence/remaining-mvp-2026-11-12/native/android-final.png)。运行过程中修正了自动化对手机折叠账号设置和页面导航的定位，以及AI表单可访问名称；最后一次通过结果为准，早期失败诊断保存在 `native/initial-attempts/`。

## PRD验收对照

“通过”指本轮规则、界面与所列运行环境的组合证据；不代表每种异常都在实体设备上人工复现。

| 编号 | 结果与主要证据 |
| --- | --- |
| P-AC01 | 通过。项目16组检查保留输入/防重，实际Windows仅名称创建并进入详情。 |
| P-AC02 | 通过本轮自动化范围。行内28组覆盖连续录入、composition/229组词保护、稳定重试；实际客户端保存中文内容。系统中文输入法候选操作尚未人工实测。 |
| P-AC03 | 通过。共同查询/适配与SQLite身份测试、浏览器跨视图、实际双端同ID同步；移动不复制由存储回归验证。 |
| P-AC04 | 通过。三态与重开、原操作版本撤销、并发编辑拒绝见恢复测试和整合页面；实际双端状态一致。 |
| P-AC05 | 通过。删除/恢复与XP回退、恢复防重见成长/恢复测试和整合页面；实际删除撤销恢复原ID与贡献。 |
| P-AC06 | 通过。空/全完成/重开/仅取消/旧树形口径见共同查询及项目页面；实际完成显示100%。 |
| P-AC07 | 通过。typed日期、确定时刻、时区和每日安排兼容见P0/P1及完整存储回归；实际AI截止原样同步。 |
| P-AC08 | 通过。待办14组及实际离线独立任务，无日期无需先加入今日。 |
| P-AC09 | 通过。成长11项规则/SQLite/偏好测试、12组组件和整合页面；实际双端10 XP及删除撤销回退。 |
| P-AC10 | 通过。真实模型先草稿后写入，用户改说明/日期并删减后只创建选中一项，跨设备字段一致。 |
| P-AC11 | 通过。程序事实与最多三项建议、读取来源、模型解释分别标识；实际Android调用后任务ID/版本不变。 |
| P-AC12 | 通过。AI组合76项及页面覆盖生成失败/停止/缓存恢复/未知回执/防重/scope切换；实际一次确认采用。异常注入使用合成服务，并非故意中断提供商写入。 |
| P-AC13 | 通过。实际同账号同步及A/B/访客切换；完整回归同时校验服务端与本地隔离。 |
| P-AC14 | 通过。实际关闭重启、桌面备份副本恢复、断网队列补传；同字段冲突保留和重启重基使用原生/SQLite回归，不冒充本次两台客户端人工制造的冲突。 |
| P-AC15 | 通过本轮双端范围。三页面、键盘、手机布局及隐藏/减少动效可继续操作，浏览器无横向溢出；实际WebView屏幕已留档。 |

## 数据保护与版本

未新增数据库迁移：桌面schema仍为25，手机工作空间仍为5。XP直接投影原任务持久事实，不建立第二套历史账本；旧状态、时间、奖励、树形和AI回执保留。原回收站和旧AI接口继续可用。恢复采用已验证副本并重启，不直接覆盖打开中的库。

本轮开始记录的565个源文件均存在，修改集中在本轮恢复、导航、成长、AI及测试；迁移相关基线未变。详见[源文件保护审计](../evidence/remaining-mvp-2026-11-12/source-audit.json)。该审计保证本轮没有删除基线文件，不将原有工作区改动声称为本轮新增。

应用版本沿用原值：Windows/工作区0.1.0，Android `versionName=1.0`、`versionCode=1`。PRD版本为v0.2。测试运行使用Node 24.21.0、Rust 1.98.1、JDK 21.0.12；未修改系统Java默认设置。现有客户端包体积/混合导入和Rust链接/增量缓存警告不影响构建，日志保留。

可复查的构建副本存于项目内 `.scratch/remaining-mvp-delivery/`：`Praxis-personal-qa.exe` 与 `Praxis-personal-qa.apk`，大小和SHA-256见[交付清单](../evidence/remaining-mvp-2026-11-12/delivery-manifest.json)。Windows为需要WebView2的x64调试独立程序，Android为独立包名的调试QA包；尚未制作生产签名安装器或发布到用户设备。

使用Windows副本复查时必须设置独立的 `PRAXIS_DATA_DIR` 和 `WEBVIEW2_USER_DATA_FOLDER`，避免默认打开个人数据。原生脚本默认使用项目内已保留的构建副本，先验证AVD和QA包身份，再仅清理该隔离QA包；运行需要项目内TLS测试证书和已配置模型环境。不要将脚本改为指向日常个人包。

## 复跑与本轮边界

```powershell
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd --filter @praxis/client build
pnpm.cmd --filter @praxis/api build
. ./scripts/native-env.ps1
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
node scripts/remaining-mvp-smoke.mjs
# 需隔离AVD/QA包、TLS证书、已编译API与Windows副本；会调用真实模型
node scripts/personal-native-acceptance.mjs
```

本轮Android验收遵循用户“先按模拟器完成本轮验收”的选择。未覆盖实体手机差异、厂商键盘及系统中文候选/手写输入；输入法组词保护已有事件级自动化与中文内容保存证据。未进行生产升级、生产签名分发或真实用户数据恢复演练。

验收后已关闭本轮独立Windows进程、临时HTTPS服务和经名称核对的 `Praxis_P4` 模拟器，并移除本轮ADB端口映射；隔离测试数据与证据保留。现有用户应用和ADB服务未清理。重新运行原生脚本前需重新启动该项目内AVD。待办/项目/行内浏览器脚本默认写入各历史阶段目录，复查时应为 `personal-todo-smoke.mjs` 显式设置 `PRAXIS_UI_SCENARIO` 与新的 `PRAXIS_UI_EVIDENCE` 目录，避免覆盖历史证据。

后续仅按个人路线评估模板、标签、重复、日历、专注、回顾和语音。多人协作不进入项目；跨设备采用同一AI草稿、100项以上单项目AI拆解、商城/装备/排行榜也不在首版范围。超过模型上下文安全上限时界面明确说明并保留手动管理。
