# 后续首版任务源文件保护审计

审计时点：2026-11-12T15:13:13.652Z（UTC）；用户时区为Asia/Hong_Kong。此审计只读源文件、Git状态与已生成验证证据，仅写本说明和[source-audit.json](source-audit.json)。

以实施前`.scratch/remaining-mvp-baseline/pre-existing-files.json`为准，565个原文件中538个SHA-256不变，27个在本轮授权范围内修改，丢失0个；新增25个范围内模块、测试或文档。未分类修改0个，未分类新增0个。

25个迁移/schema源文件哈希保持原样，没有新增迁移。修改/新增生产源文件的DDL扫描仅发现已有的ai_runs幂等初始化语句（旧实施文档已记载），没有额外DDL。原生schema25、手机schema5的既有基线未被本轮源文件修改改变。Android构建唯一相关修改是显式属性`praxisIsolatedQa=true`时使用`com.praxis.mobile.qa`，默认生产包名仍为`com.praxis.mobile`，用于隔离验收。

## 证据计数

| 检查 | 从证据重新核对 | 证据 |
| --- | --- | --- |
| TypeScript完整回归 | 57个文件、329项通过 | [typescript-tests.txt](typescript-tests.txt) |
| Rust完整回归 | 185项通过，逐suite合计，无失败汇总 | [native-tests.txt](native-tests.txt) |
| 浏览器回归 | 14 + 16 + 28 + 28 = 86组，四轮均passed且errors为空 | [浏览器汇总](browser/browser-regression-results.json) |

本次只核对计数，不重复执行测试。浏览器为真实React页面和合成原生/Capacitor桥接；源文件保护与这些计数不能代替真机、网络同步或真实模型验收。原生设备记录仍由主任务维护，本说明不把中途`native/failure.json`当作最终结论。

## 本轮修改

- `apps/api/src/ai-contract.ts` — P3 personal AI request/result contracts
- `apps/api/src/ai.ts` — P3 personal generation and read-only suggestion constraints
- `apps/client/src/PersonalProjectList.tsx` — P1-04 shared progress and empty/completed feedback
- `apps/client/src/PersonalTodoHome.tsx` — P1-04 recovery/undo, P2 growth and P3 assistant integration
- `apps/client/src/ai-mobile-adapter.test.ts` — P3 mobile adoption and compatibility regression
- `apps/client/src/ai-mobile-adapter.ts` — P3 stable personal adoption/receipt behavior
- `apps/client/src/personal-task-adapters.test.ts` — P1-04 recovery/CAS/receipt regression
- `apps/client/src/personal-task-adapters.ts` — P1-04 native/mobile recovery and undo adapters
- `apps/client/src/personal-task-storage.ts` — P1-04 trusted recovery bridge wiring
- `apps/client/src/personal-todo.css` — P1-04/P1-05 recovery and shared page layout
- `apps/desktop/src-tauri/src/store/ai.rs` — P3 personal adoption using existing transactions
- `apps/desktop/src-tauri/tests/ai.rs` — P3 native personal adoption regression
- `docs/mvp-development-plan-2026-11-09.md` — Authorized final task/evidence status update
- `packages/application/src/personal-tasks.ts` — P1-04 versioned deletion/restoration/undo contract
- `scripts/fixtures/personal-inline-scenario.mjs` — Regression selector scoped to completed section
- `scripts/fixtures/personal-project-scenario.mjs` — Regression navigation selector scoped to new primary project destination
- `scripts/fixtures/personal-todo-browser.mjs` — Isolated native/Capacitor/receipt/recovery test bridges
- `scripts/personal-todo-smoke.mjs` — Isolated regression scenarios and metadata
- `apps/client/src/App.tsx` — P1-05 two primary destinations and P3 panel wiring
- `apps/client/src/ProductivityView.tsx` — P1-05 preserved advanced/compatibility navigation
- `apps/client/src/ProjectsView.tsx` — P1-05 project/assistant and preserved legacy views
- `apps/client/src/mobile/MobileApp.tsx` — P1-05 two primary destinations and P3 panel wiring
- `apps/client/src/mobile/MobileNavIcon.tsx` — P1-05 project navigation icon
- `apps/desktop/src-tauri/src/store/productivity.rs` — P1-04 original-fact undo within existing transaction
- `apps/desktop/src-tauri/src/store/trash.rs` — P1-04 version-checked restoration and simple task eligibility
- `apps/mobile/android/app/build.gradle` — Opt-in com.praxis.mobile.qa acceptance build; production package remains default
- `packages/storage-mobile/src/workspace.ts` — P1-04 transactional original completion-fact preservation

## 本轮新增

- `apps/api/src/ai-personal.test.ts` — Authorized P1/P2/P3 regression tests
- `apps/client/src/PersonalAgentPanel.tsx` — Authorized P1/P2/P3 production module or UI
- `apps/client/src/PersonalGrowthStrip.tsx` — Authorized P1/P2/P3 production module or UI
- `apps/client/src/personal-agent-model.test.ts` — Authorized P1/P2/P3 regression tests
- `apps/client/src/personal-agent-model.ts` — Authorized P1/P2/P3 production module or UI
- `apps/client/src/personal-agent-storage.ts` — Authorized P1/P2/P3 production module or UI
- `apps/client/src/personal-agent.css` — Authorized P1/P2/P3 production module or UI
- `apps/client/src/personal-growth-settings.test.ts` — Authorized P1/P2/P3 regression tests
- `apps/client/src/personal-growth-settings.ts` — Authorized P1/P2/P3 production module or UI
- `apps/client/src/personal-growth-storage.test.ts` — Authorized P1/P2/P3 regression tests
- `apps/client/src/personal-growth.css` — Authorized P1/P2/P3 production module or UI
- `apps/client/src/personal-shell.css` — Authorized P1/P2/P3 production module or UI
- `apps/desktop/src-tauri/tests/personal_recovery.rs` — Authorized P1/P2/P3 regression tests
- `docs/p1/implementation-p1-04.md` — Authorized implementation/verification documentation
- `docs/p1/implementation-p1-05.md` — Authorized implementation/verification documentation
- `docs/p2/implementation-personal-growth.md` — Authorized implementation/verification documentation
- `docs/p3/implementation-p3-01-04.md` — Authorized implementation/verification documentation
- `docs/p4/personal-mvp-acceptance-2026-11-12.md` — Authorized implementation/verification documentation
- `packages/application/src/personal-growth.test.ts` — Authorized P1/P2/P3 regression tests
- `packages/application/src/personal-growth.ts` — Authorized P1/P2/P3 production module or UI
- `scripts/fixtures/remaining-mvp-scenario.mjs` — Authorized isolated/live/native acceptance tooling
- `scripts/personal-agent-live-smoke.mjs` — Authorized isolated/live/native acceptance tooling
- `scripts/personal-growth-smoke.mjs` — Authorized isolated/live/native acceptance tooling
- `scripts/personal-native-acceptance.mjs` — Authorized isolated/live/native acceptance tooling
- `scripts/remaining-mvp-smoke.mjs` — Authorized isolated/live/native acceptance tooling

## Git与审计边界

Git可用：true。`git status --short`和`git diff --shortstat`已经只读检查；工作区在本轮之前已有大量暂存、未暂存和未跟踪内容，所以Git整体差异不直接归因为本轮。实际归因使用565文件的独立哈希基线，不回滚或清理任何旧改动。完整列表、前后哈希及Git状态保存在JSON。

本审计没有读取或输出环境变量值，也没有修改产品源码、任务清单或Git索引。生成物/历史证据目录不纳入源文件新增统计。审计时点之后如主任务更新最终清单、交付文档或原生验收脚本，可再次运行`node .scratch/remaining-mvp-source-audit.mjs`刷新本记录。
