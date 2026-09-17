# 桌面自定义标题栏

2026-09-17，按用户参考图调整。

顶部采用 32px 留白标题栏，与侧栏和正文背景衔接。右侧提供最小化、最大化/还原、关闭按钮，关闭悬停红色。空白区域使用 Tauri 原生拖动区，内置双击最大化；正文在标题栏下滚动。仅桌面启用。

权限仅增加当前主窗口的最小化、切换最大化、关闭、拖动及内部双击最大化命令。状态监听在卸载时清理。

验证：类型检查与生产构建通过；25 项共享测试通过。真实 Tauri/WebView2 完整回归 25 项通过，包含窗口按钮原生状态变化、双击最大化、关闭测试进程；680px 宽视口验证按钮高度 32px。窗口拖动使用框架内置实现，未通过自动化执行操作系统鼠标拖拽。页面错误为 0。

[截图](evidence/desktop-titlebar/desktop-titlebar.png) · [验收结果](evidence/desktop-titlebar/native-smoke.json)

复现：构建内置页面的 Tauri 调试程序后，将 PRAXIS_EVIDENCE_DIR 设置为 docs/evidence/desktop-titlebar，运行 pnpm test:desktop。

## Standards

基准 25b1ce7，沿用已确认总审查基准。P2：窄屏通用按钮最小高度 44px 导致标题栏溢出。显式覆盖 min-height 为 32px，复核关闭。

## Spec

P3：同一窄屏高度问题偏离参考样式。已修复并复核关闭。

统计：Standards 1 项（P2）已解决；Spec 1 项（P3）已解决。
