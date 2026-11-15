# GitHub 整理与验证记录

日期：2026-11-15 至 2026-11-16（Asia/Hong_Kong）。

目标仓库：[FrostRaven05/Praxis](https://github.com/FrostRaven05/Praxis)，主分支 `main`。上传前远端没有已有分支，沿用本地现有提交历史。

## 整理内容

- 重写项目首页，集中说明当前个人版功能、目录结构、开发入口、构建与测试命令。
- 增加文档索引；旧首页保存在 `docs/archive`，原有工单和实施证据继续保留。
- 更新忽略规则，排除本地 Codex 配置、临时预览、界面审查原始捕获、工具目录、数据库、密钥、签名材料和可执行构建产物；已有 `.scratch/praxis-mvp` Markdown 工单保留。
- 汇总当前客户端、原生存储、账号/同步、版本更新及管理后台改动。

## 验证

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` / `pnpm build` | 通过；客户端构建有现存体积及动态导入提示 |
| `pnpm test` | 59 个文件、334 项测试通过 |
| `pnpm --filter @praxis/api build` | 通过 |
| `pnpm test:native` | 187 项 Rust 原生测试通过 |
| `node scripts/admin-smoke.mjs` | 13 项浏览器检查通过，无浏览器错误 |
| 常见密钥格式检查 | 工作区候选文件及已有可达提交历史未发现私钥、GitHub/provider token 或 AWS 访问密钥格式 |
| 文件大小检查 | 候选文件均小于 10 MiB，无 GitHub 单文件超限项 |

管理后台浏览器证据位于 [evidence/admin](evidence/admin/verification.json)。检查没有使用生产用户数据；本机凭据和测试原始日志留在被忽略的 `.tools` 中。

## 上传前修复

原生测试发现「删除项目、保留任务」在多级子任务存在时失败，SQLite 报 `Child project mismatch` 或 `Invalid parent reference`。原因是逐条清除项目归属时，父子关系仍生效，约束在整棵树完成迁移前就被触发。

修复保留原事务边界：先临时解除受影响的父子关系，完成所有任务的项目归属变更，再恢复原层级。现有回收站测试扩展到三层任务，同时验证任务保留、父子结构、记录链接及恢复行为；单独回归和完整原生测试均通过。

本次未进行新的 Android 真机或签名发布验收，构建产物不随源码仓库上传。
