---
version: alpha
name: Adaptive Desktop Interface
description: A general-purpose, theme-aware design system for clear and consistent product interfaces.
colors:
  primary: "#D1453B"
  primary-hover: "#B8382F"
  primary-dark: "#F28D82"
  primary-dark-hover: "#FFA399"
  on-primary: "#FFFFFF"
  on-primary-inverse: "#111111"
  surface: "#FFFFFF"
  surface-secondary: "#F9F9F9"
  surface-tertiary: "#F0F0F0"
  surface-hover: "#ECECEC"
  surface-card: "#F7F7F8"
  sidebar-surface: "#FCFAF8"
  text-primary: "#0D0D0D"
  text-secondary: "#6E6E80"
  text-tertiary: "#8E8EA0"
  dark-surface: "#212121"
  dark-surface-secondary: "#2F2F2F"
  dark-surface-tertiary: "#383838"
  dark-surface-hover: "#383838"
  dark-surface-sidebar: "#171717"
  dark-text-primary: "#ECECEC"
  dark-text-secondary: "#B4B4B4"
  dark-text-tertiary: "#676767"
  success: "#10B981"
  warning: "#F59E0B"
  danger: "#EF4444"
  info: "#3B82F6"
typography:
  display:
    fontFamily: HarmonyOS Sans SC
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.2
  headline-lg:
    fontFamily: HarmonyOS Sans SC
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.3
  headline-md:
    fontFamily: HarmonyOS Sans SC
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.4
  title:
    fontFamily: HarmonyOS Sans SC
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
  body-lg:
    fontFamily: HarmonyOS Sans SC
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.6
  body-md:
    fontFamily: HarmonyOS Sans SC
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.6
  body-sm:
    fontFamily: HarmonyOS Sans SC
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
  label-md:
    fontFamily: HarmonyOS Sans SC
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4
  label-sm:
    fontFamily: HarmonyOS Sans SC
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
  caption:
    fontFamily: HarmonyOS Sans SC
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.4
  data:
    fontFamily: ui-monospace
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  none: 0px
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  modal: 20px
  full: 9999px
spacing:
  none: 0px
  xxs: 2px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xxl: 32px
  xxxl: 40px
  huge: 48px
  section: 64px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-secondary:
    backgroundColor: "{colors.surface-tertiary}"
    textColor: "{colors.text-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-icon:
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    height: 32px
    width: 32px
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
    height: 40px
  navigation-item:
    textColor: "{colors.text-secondary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: "9px 12px"
  card:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: 16px
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.xl}"
    padding: 24px
  badge:
    backgroundColor: "{colors.surface-tertiary}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  tooltip:
    backgroundColor: "{colors.text-primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    padding: "6px 8px"
---

# General Design System

## Overview

这是一个面向桌面端和响应式产品界面的通用设计系统。目标是用稳定的语义令牌覆盖大多数页面与交互，让新界面在没有专属视觉稿时也能保持清晰、一致、克制和可访问。

系统遵循四个原则：内容优先、层级明确、状态可辨、主题可替换。通用规则只描述跨页面重复的视觉决定；活动页、报告页或营销页的局部风格应封装在自身范围内，不改变基础令牌。

## Colors

颜色通过语义角色使用。组件引用角色，不直接依赖某个主题的颜色名称。

- **Primary:** 表示主要操作、选中状态、进度和键盘焦点。每个视图只保留一个主要强调色。
- **Surfaces:** `surface` 是主背景；`surface-secondary` 用于分组和侧栏；`surface-tertiary` 用于次级控件；`surface-hover` 只用于交互反馈；`surface-card` 用于轻量容器。
- **Text:** primary 用于正文与标题，secondary 用于说明，tertiary 用于元数据和弱提示。交互文字仍需满足可读性，不能仅因品牌需要降低对比度。
- **Status:** success、warning、danger 和 info 只表达状态。状态必须同时配合文字、图标或形状，不能只靠颜色传达含义。
- **Dark mode:** 深色模式替换整套 surface 和 text 角色。它不是把浅色值简单反相，也不改变组件结构。

`primary` 是默认主题种子。切换主题时，应成组替换 primary、primary-hover、primary-dark 和 primary-dark-hover；其余语义角色保持稳定。浅色背景、边框和焦点底色应由当前角色通过透明度或 color-mix 派生，减少相近硬编码色。

## Typography

界面首选 HarmonyOS Sans SC，并回退到系统无衬线字体。字号层级应以语义角色选择，避免为单个元素创建临时尺寸。

- 14px 是正文和控件基准；13px 用于辅助信息；11–12px 用于时间、计数、标签和元数据。
- 16–24px 用于页面及分区标题；48px display 只用于低密度的焦点场景。
- 400 用于阅读，500 用于标签和控件，600 用于标题与选中状态，700 用于展示标题和关键数字。
- 路径、ID、端口、日志、代码和需要对齐的数字使用 `data` 等宽样式。
- 正文行高保持 1.5–1.6；标题使用 1.2–1.4。长文本使用自然换行，数据和标识符按语义决定截断或断行。

## Layout

布局以 4px 为基础单位，主要使用 8px、12px、16px、24px 和 32px。控件内部采用 8–16px，容器内部采用 16–24px，页面区块之间采用 24–64px。

- 使用稳定的应用壳层承载导航、标题和全局状态；页面内容在自身区域滚动，避免整个窗口因局部数据变化而跳动。
- 宽屏优先并排展示相关内容；空间不足时按重要性折叠、换行或切为单列，而不是缩小文字和点击区域。
- 表格与数据页可以提高密度，但筛选、主要动作、状态和列标题必须保持清晰。
- 模态窗口保留可视边距，并限制正文宽度；长内容在模态内部滚动。
- 响应式断点由内容开始失效的位置决定。优先复用已有断点，避免为孤立像素问题增加新断点。

## Elevation & Depth

基础界面保持浅层，通过表面色差、1px 低对比度边框和留白建立层级。普通卡片不依赖明显阴影。

- 下拉菜单、浮动工具和提示使用小范围柔和阴影。
- 模态窗口使用半透明遮罩、轻度背景模糊和中等阴影。
- 焦点、选中和悬浮是交互状态，不应通过持续发光或厚重阴影表达。
- 装饰性强的渐变、玻璃和舞台光效只属于明确隔离的局部主题。

## Shapes

8px 是通用控件圆角，12px 用于卡片，16px 用于大面板和模态，20px 仅用于需要更强柔和感的强调容器。

全圆角用于头像、状态点、徽标、切换器、pill 和圆形图标按钮。相同层级的元素采用相同圆角；圆角差异应表达结构或功能差异。

## Components

- **Buttons:** 主按钮使用 primary 与 on-primary；次按钮使用 tertiary 表面；危险按钮使用 danger。悬浮使用对应 hover 状态，禁用态保留结构并降至约 50% 不透明度。
- **Icon buttons:** 使用统一的线性图标族，常见图标为 16–20px，容器至少 32px。默认透明，悬浮时出现背景；图标旁有文字时不重复表达同一含义。
- **Navigation:** 默认使用 secondary 文字，悬浮显示背景，选中态同时改变背景、字重以及图标或位置标记。
- **Inputs:** 使用 1px 低对比度边框。聚焦时边框变为 primary，并显示 2–3px 浅色焦点环。placeholder 使用 tertiary 文字色，错误信息紧邻字段出现。
- **Cards:** 使用 card 表面、12px 圆角和 16px 基础内边距。只有可点击卡片才具有明确 hover 状态。
- **Dialogs:** 内容顺序为标题、说明、主体和动作。主要动作位于阅读顺序末端；不可逆操作使用明确动词和危险样式。
- **Badges and status:** 使用紧凑字号和全圆角。徽标用于短状态或计数，不承载长句。
- **Tooltips:** 只补充无法从标签和图标直接理解的信息；简短、可延迟出现，并且不遮挡当前操作目标。
- **Motion:** 悬浮与状态切换使用 150–200ms，面板与模态进入使用 200–300ms，优先 ease-out。加载动效只在任务进行时循环，并响应 `prefers-reduced-motion`。

## Task controls

任务控件参考 Todoist 的[任务详情](https://www.todoist.com/help/todoist/features/use-the-task-view-to-manage-tasks-in-todoist-eDeRDO0C)、[快速添加](https://www.todoist.com/help/todoist/product-updates/a-cleaner-simpler-quick-add-june-29-PuIpiLmLh)和[快捷键](https://www.todoist.com/help/todoist/features/use-keyboard-shortcuts-in-todoist-Wyovn2)，按 Praxis 现有任务模型实现：

- 录入保持单行与回车保存；`Q` 定位当前视图的录入框。常用操作直接显示，层级移动、子任务等操作收进更多菜单。
- 日期与截止时间统一使用简洁月历：圆形选中日期、今天描边、相邻月份淡化；点击年月展开月份选择，箭头切换月份或年份，点击日期直接选中并收起。移除弹层底部的日期输入、确认、提示和今天区域。截止时间仅增加时分选择，并保留清除入口。选择安排日期只修改表单草稿，保存或安排任务才写入本机；安排日期与截止时间分别保存。
- 更多菜单支持上下方向键、Home、End；表单字段保留自身的编辑按键。月历使用单个 Tab 入口，方向键移动日期，Page Up/Down 移动月份，Shift+Page Up/Down 移动年份，月末不足时停在当月最后一天。
- 弹层靠近触发控件，适配窗口边界；点击外部、移出焦点或按 Esc 收起。详情中的 Ctrl+Enter 保存，Esc 收起已保存的详情；有草稿时显示保存与取消修改入口。
- 圆形完成控件切换任务完成状态；重点标记与拖动排序分别处理，不改变上午、下午、晚上分组。
- 收件箱点击任务直接打开右侧编辑栏，列表保持可见；不再展开行内操作或打开详情模态。默认没有日期，编辑保存后仍留在收件箱；选择日期并保存后进入对应日程。草稿阻止切换任务，支持取消修改和 Ctrl+Enter 保存。
- 日程页通过固定宽度的扁平日期条或月历切换日期，标题仅供辅助技术读取；保存后直接更新任务列表，详情有未保存修改时日期导航暂时禁用。页面不显示额外的保存成功提示、当前查看日期说明、返回今日横幅或标题与日期修改回执。

项目的列表与看板参考 [Todoist 入门说明](https://www.todoist.com/zh-CN/help/todoist/get-started/get-started-with-todoist-OgNNJR)及[看板布局](https://www.todoist.com/help/todoist/features/use-the-board-layout-in-todoist-AiAVsyEI)。列表、甘特图和看板共用项目标题、视图切换、任务录入及更多选项：

- 列表保留圆圈完成、标题详情、子任务折叠和同级拖动排序。仅展示实际日期、子任务进度和必要状态；已完成与已取消任务按需查看。
- 看板使用列标题、数量和紧凑卡片。普通状态立即保存；阻塞或取消时填写原因。失败保留原操作并提供重试或重读。
- 甘特图以时间轴和任务行为主；日期与依赖在编辑时出现，低频设置放入更多。单项排期直接保存，涉及其他任务或依赖顺延时确认方案；每日安排与项目排期保持独立。
- 空态使用简短文字，保存后直接刷新；不显示持久的成功提示、撤销回执、重复任务选择区或无内容的筛选开关。

## Do's and Don'ts

- Do 使用设计令牌和语义角色实现组件，让同一结构自然适配主题与明暗模式。
- Do 用间距、表面、边框、排版和位置共同建立层级。
- Do 为交互提供 hover、active、focus、disabled、loading、empty、error 和 success 状态。
- Do 保留可见的键盘焦点，并核验普通文字与关键控件的对比度。
- Do 优先复用既有组件模式；重复出现的局部样式应提升为通用令牌或组件规则。
- Don't 在组件内硬编码新的近似灰色、浅强调色或 hover 色。
- Don't 只用颜色表达选中、危险、进度或成功。
- Don't 给普通容器添加厚重阴影、装饰性渐变或大面积强调色。
- Don't 通过缩小字体、压缩点击区域或隐藏必要标签来适配窄屏。
- Don't 将一次性页面的视觉语言提升为全局规则，除非它已经在多个独立界面中稳定复用。
