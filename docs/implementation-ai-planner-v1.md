# AI 规划与修炼成长首版

> 最新进展：项目恢复已加入恢复卡、近期记录、来源引用和项目内时间筛选。当前范围与边界以 [项目恢复说明](implementation-project-recovery.md)、[奖励闭环说明](implementation-cultivation-rewards.md) 和 [开发进度](ai-cultivation-progress.md) 为准；下文保留各轮首版记录。

2026-10-25。本轮按 `docs/ai-agent-integration-design-2026-10-25.md` 实现首个纵向版本：先形成可编辑规划草稿，明确采用后进入现有任务系统；以自身修炼承接真实行动与阶段成果。本轮按用户确认只做自身修炼界面，不加入灵宠。

## 实现范围

| 场景       | 入口与行为                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------- |
| 灵感与愿望 | 收集箱“整理想法”，可从原始收集项发起；保留原文、假设与待澄清问题                               |
| 项目拆解   | 项目“拆成步骤”，一次最多八步，逐步编辑标题、完成标准、估时，勾选采用；自动包含所需前置步骤     |
| 重新启动   | 项目“继续推进”，读取当前项目快照，优先建议已有可执行叶子任务，避免再次创建同一行动             |
| 采用与撤销 | 原文、任务、依赖和奖励约定在同一数据库事务保存；固定操作编号支持重试；输出未被继续使用时可撤销 |
| 修炼成长   | 桌面侧栏“修炼成长”，行动包累计修为、设定阶段成果和奖励、确认成果后突破、记录奖励领取           |

生成期间可取消或稍后查询；关闭助手后草稿仍保留。输入与草稿按服务地址、账号、场景及来源隔离。采用时核对原文版本、项目版本、计划版本和全部项目任务版本；过时草稿必须重新读取。任务不会被自动加入今天或排期。奖励建议先成为普通“奖励约定”记录，供用户自行确认和调整。

修炼每个行动包计十点修为，同一根任务的子任务合并计一次。撤销完成会相应校正累计，休息与缺席不会扣分。突破同时要求保存阶段后新增的行动积累，以及用户对阶段成果的明确确认。奖励领取仅记录事实。

## Agent 的范围

整理与拆解采用固定工作流；继续推进允许模型调用 `read_project` 与 `list_ready_tasks` 两个只读工具。工具只返回当前请求中的项目快照，不接受其他项目编号。模型无数据库写入、奖励发放、付款、删除、联网搜索或自动排期工具。

模型输出需通过严格结构、长度、任务数、依赖闭环和已有任务身份检查；本地采用事务再做一次业务校验。服务最多四轮模型交互、八次工具调用、一次格式修复，整次运行四十五秒超时。默认同一用户同时运行一个请求，全服务同时四个；每日按 UTC 日期限制为每用户二十次、全服务二百次。重复查询或原请求重试不会重复计数。

请求和最终结果持久化到服务端 `ai_runs`，账号间不可查询。重启后未完成运行标记为中断；取消或超时后的迟到结果不能覆盖终态。模型密钥仅在 API 服务端，桌面和 Android 通过各自的原生认证桥访问，不把登录令牌交给页面。

## 自身修炼界面补充

用户已确认：当前路线为自身修炼界面，没有灵宠。

- 桌面采用 AI 规划后，新增“带入自身修炼”。它将已编辑的成果、奖励约定和实际采用的行动数量带到成长页，不再次生成任务。
- 奖励约定条件优先成为阶段成果，用户取消保留奖励时不带入奖励。原条件超过阶段成果字段上限时保留原文供参考，并要求用户自行写出较短的成果，不静默截断。
- 打开修炼页只是带入可编辑草稿；保存时仍调用原有带版本检查、操作编号与恢复能力的领域命令。若当前已有进行中的阶段，按钮明确写为“替换当前阶段并保存”；也可放弃草稿而保留当前阶段。
- 规划草稿按来源账号检查；修炼页内修改后的带入内容在本次应用会话内保留，保存成功或主动放弃后清除。它尚未提供退出应用后恢复这份修炼设置草稿的能力；原 AI 规划仍可按首版机制恢复。
- 行动数量只是可编辑的阶段目标，仍按保存后全部已完成行动包积累，并由用户确认成果后突破，尚未限定为所选项目的专属计数。

本次全项目类型检查、四十个测试文件的 204 项测试、前端构建与内嵌资源的桌面构建通过。真实 WebView 验收仍受当前环境调试连接限制，未标记通过；证据见 `docs/evidence/self-cultivation-v2/result.json`。

本次仅修改客户端交互与纯校验，不新增数据库迁移。新程序位置为 `.tools/releases/self-cultivation-v2/Praxis.exe`。原有 AI 采用和撤销、任务身份与修炼业务规则继续复用。

## DeepSeek 适配补充

2026-10-25：已补充读取现有 `DEEPSEEK_API_KEY` 的能力，无需复制到新的变量或写入项目文件。原生客户端继续通过已登录的 Praxis API 服务访问模型；不会直接读取电脑密钥。

- 优先使用显式设置的 `PRAXIS_AI_API_KEY`。未设置时使用 `DEEPSEEK_API_KEY`，默认服务为 `https://api.deepseek.com`、模型为 `deepseek-flash`。
- 可用 `DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL` 调整 DeepSeek 默认项；`PRAXIS_AI_BASE_URL`、`PRAXIS_AI_MODEL` 有更高优先级。需要代理兼容模式时可明确设置 `PRAXIS_AI_PROVIDER=deepseek`。
- DeepSeek 使用 `json_object`、格式说明和示例，并在本地继续执行严格提案校验；不会把 JSON 格式合法当作业务合法。采用稳定版工具调用协议，不依赖 Beta strict tool；每次请求明确关闭 thinking 模式，保持当前短规划的运行预算。继续推进首轮要求读取当前项目。
- `compose.yaml` 已传递上述变量，并移除会覆盖 DeepSeek 默认项的 OpenAI 固定默认值。密钥仅通过服务进程环境注入。

本机已检查到当前进程和系统级 `DEEPSEEK_API_KEY`，没有打印密钥内容。对官方 `/models` 的联网探测在域名解析阶段返回 `ENOTFOUND`，尚未获得服务端响应，不能判断密钥有效性；未部署至线上。此前“从未调用真实模型”的验证边界仍适用。

构建 API 后，可在正常联网的终端运行 `node scripts/ai-live-smoke.mjs`。该脚本用三个虚构案例检查整理、拆解与已有项目继续推进，通过当前认证与 Run API 调用模型；不创建业务任务，不保存或输出密钥。它会产生少量模型调用费用。

适配回归：新增十项供应商配置／协议测试通过，全量三十九个测试文件、199 项测试通过；全项目类型检查与 API 构建通过。实际认证 Run 链路已识别 `provider=deepseek` 与 `model=deepseek-flash`；首个虚构案例因当前网络无法解析官方域名而以 `AI_UPSTREAM` 失败，没有业务任务写入。证据见 `docs/evidence/ai-deepseek/result.json`。

接口依据：[DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)、[Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)、[模型列表与默认模式](https://api-docs.deepseek.com/quick_start/pricing/)、[Thinking 模式](https://api-docs.deepseek.com/guides/thinking_mode/)。

## 配置与启动

如果显式使用 OpenAI 或兼容服务，可配置以下 Praxis 变量；已有 DeepSeek 环境变量按上一节直接读取：

```text
PRAXIS_AI_API_KEY=填写自己的模型服务密钥
PRAXIS_AI_BASE_URL=https://api.openai.com/v1
PRAXIS_AI_MODEL=gpt-4.1-mini
```

后两项可省略；OpenAI 模式使用严格 JSON Schema 与工具调用，DeepSeek 模式使用上文说明的 JSON Output 兼容协议与本地严格校验。非本机模型地址必须使用 HTTPS。设置后重启更新后的 API 服务；现有 `compose.yaml` 已接入这些变量。上述两种密钥都未配置时返回明确的未启用提示，并保留用户输入和草稿。

本轮没有部署或重启线上服务，已有电脑上的 DeepSeek 密钥仅由服务进程读取，未复制或持久化到项目文件。实际模型的输出质量、供应商兼容性与延迟仍需配置后进行小范围验证。

## 本地构建与验收

已有依赖的工作区可直接运行：

```powershell
node.exe node_modules/typescript/bin/tsc --noEmit
node.exe node_modules/vitest/vitest.mjs run
node.exe node_modules/typescript/bin/tsc -p apps/api/tsconfig.json
node.exe apps/api/scripts/copy-admin.mjs
Push-Location apps/client
node.exe node_modules/vite/bin/vite.js build
Pop-Location
. .\scripts\native-env.ps1
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked -j 1
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --features tauri/custom-protocol -j 1
```

先完成前端构建，再构建内嵌资源的桌面程序。完整原生测试之后需重新构建内嵌资源版本，避免使用指向开发服务器的测试构建。桌面样本验收脚本为 `scripts/native-ai-planner.mjs`，默认读取 `.tools/releases/ai-planner-v1/Praxis.exe`，通过独立本地 HTTPS 服务、临时测试账号与数据库运行，不调用真实模型，也不操作正常账号的数据。

## 本轮验证结果

- TypeScript 全项目类型检查通过；Vitest 全量 38 个文件、189 项测试通过。
- Rust 原生全量测试通过，包含 AI 原子采用、重放、重启读取、依赖撤销、冲突保护及修炼积累/突破。原生测试将 TEMP/TMP 指向工作区独立临时目录，并采用单编译进程，避开当前环境的临时目录权限和编译资源限制。
- API 构建、Vite 生产构建、内嵌前端资源的 Windows 调试 EXE 构建通过。Android 原生网络桥通过独立 javac 编译检查。
- 桌面真实 WebView 脚本已保存，但本轮在连接本机调试端口时遇到 `EACCES`，尚未执行到界面功能验收。随后桌面检查工具也未能启动（`failed to launch codex app-server: program not found`）。`docs/evidence/ai-planner-v1/result.json` 保留失败记录，不视为界面验收通过。
- 模型协议、只读工具、输出检查、取消、超时、格式修复和配额测试使用假供应商；未调用真实付费模型。

Windows 程序：`.tools/releases/ai-planner-v1/Praxis.exe`。该文件已从内嵌资源构建产物单独复制，可直接打开查看新入口。AI 生成须连接配置完成的新版服务；当前线上服务未更新。修炼成长可本机使用。

## 交付边界

- Windows：提供内嵌页面的调试 EXE；尚无签名安装包。数据库新增迁移 `0024_ai_planner.sql`。
- Android：接入生成、草稿编辑、单事务采用和安全撤销；原生网络桥编译检查与真实宿主 SQLite 测试不替代手机端实机验收。
- 修炼成长：本版仅桌面本机保存，尚未提供跨设备成长账本和手机成长页面。普通任务继续使用现有同步机制。
- 草稿与采用回执：本版恢复以当前设备为范围；不承诺跨设备继续同一草稿或在另一设备撤销。
- 奖励：可从规划带入成长页进行确认保存；尚未形成统一奖励账本，不自动双向同步两处修改。
- 本轮不加入灵宠。主动定时规划、后台自主执行、长期记忆与外部信息检索不在本版。

本版完成 T32–T34 中与有限规划、明确采用和基础成长有关的首个切片，其余验收范围不提前标记完成。
