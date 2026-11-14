# P0-03 实施与验证记录

日期：2026-11-11  
结果：P0-03完成，P0三项任务完成。下一项P1-01个人待办首页。

本阶段实现[共同查询与变更接口](personal-task-interface.md)，复用原个人存储、账号隔离与事务，继续保留所有既有功能入口和数据。没有新增数据库迁移、账号合并或真实用户库迁移。

## 交付内容

1. **共同查询**：个人任务列表、同ID详情、独立/项目筛选、四类待办分组及项目进度来自同一读取结果；无需加入今日。原状态、等待标记、完成标准、typed日期与本地编辑版本明确保留，空项目与旧树进度有一致规则。
2. **共同变更**：提供标题/说明/截止修改、三态变更和个人项目归属变更。桌面使用原Productivity命令；手机使用原workspaceCommand并在事务内检查预览任务及项目版本。项目变化保留原ID，旧子树须确认，已有依赖及关联重开继续走原确认路径。
3. **防重与作用域**：提交前固定完整命令；结果不明时仅重试原内容。提交时核对当前账号/工作空间，保留本地与网络版本各自用途；不按远端版本推算编辑版本。
4. **兼容修复**：手机普通编辑不再给未知历史完成日期补当前时间；同步保留显式未知完成日期和实际已知完成时刻；明确修改同一天的typed截止会生效；重新生成原生实体投影时保留未知扩展字段，并继续去除本地owner/CAS字段。
5. **现有页面接入**：桌面工作区读取、手机任务日期/旧状态显示、项目详情进度已复用共同规则。保留原每日准备、日历安排、层级、看板、排期、回收站、习惯、修炼和AI路径。新个人首页仍由P1-01交付。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 类型检查 | 通过，exit 0 | [typecheck.log](../evidence/p0-03-2026-11-11/typecheck.log) |
| 完整TypeScript回归 | 49文件、285项通过；新增10项共同规则/双端适配测试 | [typescript.log](../evidence/p0-03-2026-11-11/typescript.log) |
| 完整原生存储回归 | 179项通过；新增3项真实SQLite/实体同步测试 | [native.log](../evidence/p0-03-2026-11-11/native.log) |
| 客户端构建 | 通过，exit 0；仍有动态/静态混合导入与大chunk提示 | [client-build.log](../evidence/p0-03-2026-11-11/client-build.log) |
| API构建 | 通过，exit 0 | [api-build.log](../evidence/p0-03-2026-11-11/api-build.log) |
| 文件保护 | 实施前529个文件按哈希核对，仅列明的生产模块及计划更新；旧迁移脚本与其他文件无意外变化 | [results.json](../evidence/p0-03-2026-11-11/results.json) |

新增验证覆盖：无日期/未安排任务、列表详情同对象、旧等待/阻塞/取消、空项目及有效叶子进度、香港自然日跨界、旧洛杉矶时刻与夏令时、未知完成日期、跨账号拒绝、项目状态变化、子树移动、旧版本拒绝、结果不明后的原命令重放、未知字段与typed截止保留。

原生回归还运行P0-02升级与整库恢复、原M0备份、现有账号隔离、层级、完成/撤销、AI采用/回执及修炼等测试。通过不代表P4的双端真机界面和真实模型验收已经完成。

## 复跑方式

```powershell
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd test:native
pnpm.cmd --filter @praxis/client build
pnpm.cmd --filter @praxis/api build
```

针对性用例：

```powershell
pnpm.cmd exec vitest run packages/application/src/personal-tasks.test.ts apps/client/src/personal-task-adapters.test.ts
. ./scripts/native-env.ps1
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --test personal_queries --test entities_identity_review
```

新增测试只使用临时或内存合成数据库。手机适配在宿主SQLite验证，原生测试调用真实Store与实体同步路径；没有启动真实应用、操作Android真机、发出真实模型请求或部署。实施前文件清单在 `.scratch/p0-03-baseline/pre-existing-files.json`，历史证据继续保留。

## 后续任务

按[当前开发计划](../mvp-development-plan-2026-11-09.md)进入 **P1-01 个人待办首页**，将共同查询中的全部个人未完成任务及四类截止分组呈现到默认首页，再按后续任务接入行内编辑、状态、短项目表单和恢复反馈。本阶段没有提前勾选P1或完整P-AC产品验收。
