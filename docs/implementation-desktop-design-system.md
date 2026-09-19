# D10 — DESIGN.md 设计系统统一
以根目录 DESIGN.md 为界面规范。theme.css 集中定义棕色强调色、中性表面与文字、状态色及派生边框/焦点色；随系统明暗设置替换完整主题。原样式及甘特SVG颜色全部引用语义变量。字体优先 HarmonyOS Sans SC，未安装时回退 Segoe UI、Microsoft YaHei；不额外下载字体。

components.css 统一按钮、40px输入、卡片、徽标、24px内边距弹窗及焦点/悬浮/禁用态，支持减少动态效果；保留D09紧凑布局和追踪项目。DESIGN.md 原文纳入版本管理，未修改规范内容。

## Standards
基点ec53a1e。独立审查发现P2按钮级联覆盖图标样式，以及后续P3图标悬浮背景被覆盖。已降低通用规则优先级，补充图标悬浮规则和原生断言，定向复核关闭。

## Spec
发现同一P2按钮级联问题，修复后复核关闭。

统计：Standards 2项已关闭；Spec 1项已关闭。

## 验证
类型检查和34项共享测试通过。真实Tauri/WebView2验收37项通过，页面异常0；包括浅/深色计算样式、字体优先级、焦点边框、辅助文字、重点图标内边距/选中色/悬浮背景，以及既有项目、看板、甘特和持久化流程。已人工检查明暗截图，修正了迁移过程中的辅助文字映射问题。未改变Rust存储逻辑。

[原生结果](evidence/desktop-design-system/native-smoke.json) · [浅色截图](evidence/desktop-design-system/desktop-captured.png) · [深色截图](evidence/desktop-design-system/desktop-dark.png)
