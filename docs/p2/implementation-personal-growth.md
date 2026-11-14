# P2 个人成长模块实施记录

日期：2026-11-12。范围：P2-01个人任务经验、P2-02旧修炼历史兼容、P2-03轻量成长展示。此记录由成长子任务维护；应用接入、完整回归和总任务状态由主任务统一确认。

## 数据与规则

[个人成长投影](../../packages/application/src/personal-growth.ts)使用已有持久任务状态作为唯一事实账本，不新增XP表、复制任务、迁移旧奖励或修改同步协议。

- 在一个可信个人账号/工作空间快照内，使用`scopeKey + taskId`标识贡献；只有`rawStatus ?? status`明确为`completed`且未删除的任务贡献10 XP。不能从树形百分比、父子推导或旧修炼数值推导完成。
- 项目归属不参与贡献身份，移动任务不重复计算。重开或删除后贡献消失，恢复有效完成任务后还原一份。状态本身与原任务ID已持久化，因此重启、同账号同步和备份恢复后仍按同一组事实计算，不维护可能漂移的第二份计分账本。
- 每100 XP升一级，等级为`1 + floor(XP / 100)`，当前等级经验为余数。空数据为Lv.1、0 XP。
- 仅完整且有效的确定时刻用于“今天完成”，按个人工作空间时区判断，并排除未来时刻。未知、非法或只有日期的历史完成时间不伪造成今天；这类明确完成任务仍贡献总XP。
- 重复任务ID属于来源不明确，显示成长查询警告，避免选择某个版本或双计。任务管理保持可用。

旧行动包修为、境界、突破、已领取奖励、AI来源及旧扩展数据继续保留在原位置。新模块不调用会维护旧修炼状态的`cultivation_snapshot`，不读取旧修为作为任务XP，也不为已有历史制造新的完成事实。无需成长迁移，重复读取不写入状态或同步队列。

## 组件与接入

[PersonalGrowthStrip](../../apps/client/src/PersonalGrowthStrip.tsx)是独立组件，提供等级徽章、经验条、总XP与今天完成数量。只在个人待办首页使用，不放大到每个项目或增加领奖步骤。

```tsx
import { PersonalGrowthStrip } from "./PersonalGrowthStrip";

{base && !projectId && (
  <PersonalGrowthStrip
    scopeKey={base.scopeKey}
    tasks={base.work.tasks}
    timeZone={query?.timeZone ?? base.fallbackZone ?? "UTC"}
    now={now}
    onOpenLegacy={openOriginalCultivation}
  />
)}
```

`onOpenLegacy`可选；调用方应沿用当前页面的导航保护。已有旧修炼入口必须保留，不能把此回调当成新的旧修炼数据存储。

桌面可导航到原`CultivationPanel`。手机原本没有该桌面境界/领奖界面，不能调用桌面专用invoke冒充可用入口；不传回调时按钮不显示。手机旧AI奖励想法保存为`record`（“奖励约定：…”），继续通过原记录页访问，来源回执保留在原AI来源/历史中；记录页不等同于完整桌面旧修炼界面。

首次读取和切换账号不显示虚构的新增经验提示。后续贡献变化显示约700毫秒的文字反馈，升级时附等级，回退时明确变化；不遮挡、阻塞或要求确认。组件沿用现有主题令牌，包含明暗主题及小屏布局。

“成长显示设置”支持减少动效与隐藏成长。隐藏后仍保留“显示成长”按钮，用户能够恢复。系统`prefers-reduced-motion`也会关闭动效，保留文字反馈。偏好通过[作用域设置](../../apps/client/src/personal-growth-settings.ts)按可信`scopeKey`保存在本设备localStorage，不做跨设备偏好同步；新账号或工作空间不能继承另一作用域的偏好。写入偏好失败只提示本页生效，不影响任务与XP事实。

## 验证

| 检查 | 子任务结果 | 证据 |
| --- | --- | --- |
| 成长规则 | 6项通过 | [targeted-tests.txt](../evidence/p2-2026-11-12/targeted-tests.txt) |
| 偏好隔离 | 3项通过 | 同上 |
| 真实手机SQLite事实及备份 | 2项通过 | 同上 |
| 独立成长组件界面 | 桌面/手机合计12组通过，无页面异常 | [component-ui-results.json](../evidence/p2-2026-11-12/component-ui-results.json) |
| 明暗主题、小屏、减少动效 | 已视查，无横向溢出 | [手机](../evidence/p2-2026-11-12/mobile-growth-light.png)、[桌面](../evidence/p2-2026-11-12/desktop-growth-dark.png) |

真实SQLite测试覆盖完成回执重放、项目移动、删除恢复、重开再完成，以及未知历史完成日期、旧奖励扩展和可重复备份恢复。只读投影前后比较持久工作空间内容与队列，除导出时间外内容一致。

组件界面检查使用真实React与成长投影、合成任务事实，验证等级更新、贡献回退恢复、偏好重载与账号隔离、隐藏后的恢复入口、旧修炼回调、系统减少动效和偏好写入失败。它是独立组件证据，不代替已接入App/MobileApp后的完整流程，更不代替Windows/Android真机或实际账号同步。

```powershell
pnpm.cmd exec vitest run packages/application/src/personal-growth.test.ts apps/client/src/personal-growth-settings.test.ts apps/client/src/personal-growth-storage.test.ts
node scripts/personal-growth-smoke.mjs
```

不修改真实用户数据库、数据库版本或旧修炼历史。应用接入和P4完整验收的最终结果请以主任务汇总为准。
