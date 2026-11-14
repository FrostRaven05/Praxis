# P0-02 实施与验证记录

日期：2026-11-11  
结果：P0-02完成，P0-03待执行。整个产品继续只做个人管理。

本阶段完成[个人数据兼容清单](personal-data-compatibility.md)，列明17类数据的原存放位置、保留方案、结构/编辑/网络/草稿版本的区别，以及后续阶段的实现约束。新增[个人合成样本](personal-compatibility-fixtures.json)与5项存储回归测试，未修改生产代码、既有迁移脚本或真实用户数据。

## 本次交付

- 桌面schema10升级到25：保留任务ID、版本、说明与完成标准；旧时刻及显示时区正确映射；计划与截止分别保存；未知完成时间仍为空；升级前自动备份和重开结果可核对。
- 当前桌面库：通过已有个人命令将同一任务从独立任务纳入项目，再移到另一项目；版本7→8→9，重放不重复、旧版本拒绝。备份恢复57张表逐列相同，包含未知表、旧修炼和奖励、未完成同步操作与冲突、AI命令及采用回执。恢复后重试原AI采用命令无新增任务。
- 手机存储：在宿主SQLite执行schema2→5脚本，保留旧任务、原文、事件和outbox；验证当前工作空间整库副本、重开、等待标记、旧时刻扩展、未知完成日期、冻结待发命令及同步冲突。不同账号的独立库不混数据，跨身份重新绑定被拒绝。
- 已区分完整数据库副本、手机工作空间JSON导出、localStorage草稿与AI缓存的覆盖范围。后续不能以工作空间导出成功为由清除其他本地内容。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| TypeScript类型检查 | 通过，exit 0 | [typecheck.log](../evidence/p0-02-2026-11-11/typecheck.log) |
| 完整TypeScript回归 | 47文件、275项通过，含新增3项手机兼容测试 | [typescript.log](../evidence/p0-02-2026-11-11/typescript.log) |
| 完整原生存储回归 | 176项通过，含新增2项桌面兼容测试 | [native.log](../evidence/p0-02-2026-11-11/native.log) |
| 旧结构升级 | 10→25；升级前备份及重开一致 | [desktop-upgrade.json](../evidence/p0-02-2026-11-11/desktop-upgrade.json) |
| 桌面恢复 | 57表全部相等，原库不变，AI原命令重放不重复 | [desktop-roundtrip.json](../evidence/p0-02-2026-11-11/desktop-roundtrip.json) |
| 原文件保护与清单 | 524个实施前文件中仅当前PRD与开发计划按预期更新；生产代码和迁移脚本未变化 | [results.json](../evidence/p0-02-2026-11-11/results.json) |

完整回归包含已有账号隔离、同账号双设备、AI草稿/回执/失败恢复、日期时区、旧树、修炼和备份测试。新增测试中的第一次试跑修正了样本调用：旧capture命令的发生日期须匹配安排日期；已有项目间变更须使用Move命令和完整预览版本集合。没有放宽生产校验。

## 复跑方式

从项目根目录运行，命令只创建临时/内存合成数据库：

```powershell
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd test:native
```

仅跑新增兼容用例：

```powershell
pnpm.cmd exec vitest run packages/storage-mobile/src/personal-compatibility.test.ts
. ./scripts/native-env.ps1
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --test personal_compatibility
```

可选环境变量 `PRAXIS_PERSONAL_COMPAT_EXPORT_DIR` 指定桌面测试报告目录，仅写两份合成结果JSON，不导出用户资料。实施前哈希保存在 `.scratch/p0-02-baseline/pre-existing-files.json`；结果汇总保存摘要和实际变化文件，原M0/M1证据未覆盖。

## 验收边界与下一步

P-AC03、P-AC07、P-AC14完成了本阶段要求的数据兼容验证；未宣称完整产品验收。此次没有修改界面、打包部署、连接真实模型、执行真实用户迁移或操作Android真机。手机整库副本测试是宿主SQLite验证，不是新交付的手机完整备份产品功能。

下一项 **P0-03**：统一当前账号的个人任务查询、日期与旧状态投影，保留未知扩展字段，复用原业务事务、独立的本地/远端版本、稳定操作ID和项目移动命令。新核心页面、XP与AI分别在P1、P2、P3实施。
