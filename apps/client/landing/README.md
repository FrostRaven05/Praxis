# Praxis 落地页

独立于应用界面的中文产品介绍页，沿用 Praxis 的个人任务与项目管理定位、鼠尾草绿强调色和砖红色 P 标识。

从仓库根目录运行 `pnpm dev` 后，打开 <http://127.0.0.1:1420/landing/>。

`pnpm build` 同时构建应用与落地页，页面产物位于 `apps/client/dist/landing/index.html`，引用同一 `dist/assets` 中的静态资源。发布时保留整个 `dist` 目录结构。应用的根入口保持为 `dist/index.html`。

页面提供今日任务勾选、添加演示任务、项目看板与列表切换、番茄钟开始与暂停，以及常见问题折叠。演示状态只存在于当前页面，不写入真实任务或本地存储。浏览器预览链接指向应用入口；原生存储等能力需使用桌面或手机应用。

下载按钮使用 `docs/evidence/installers-1.0.4/publication.json` 中已记录发布的 Windows x64 和 Android 安装包。发布新版本时同步替换两个链接。在线字体不可用时自动回退到系统字体。
