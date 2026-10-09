# T22 Android 离线收集（实现完成，真机验收受阻）

日期：2026-10-09。对应 DEV-10、CAP-001/002、AT-01 本地部分、AT-36/37。

## 已实现

手机默认入口由主线程接入 `MobileCaptureView`：独立原文收件箱，不再把随手记强制变成每日任务。原文空白、换行完整保留；非空且不超过 100,000 个 Unicode 字符即可保存，超限明确提示且不截断输入，支持版本检查的原文编辑。显示本地模式、待同步操作数；不宣称内容已上云。读失败与空列表区分。返回前台重新读取；未知保存结果保留输入并锁定同一操作供重试，明确校验或版本拒绝解除锁定，冲突原文可另存为新收集项；父页面使用 onBusyChange 阻止未保存草稿期间切换入口。文本区域不绑定 Enter 保存，并拦截输入法组合期间提交；触控目标至少 44px，使用安全区边距和可换行布局。

`MobileStorage` 公共接口新增 saveCapture/listCaptures/captureQueueCount，沿用现有串行 SQLite 连接。实体、capture_events 和 sync_outbox 同事务提交；操作 ID 重试检查已持久化历史，提交响应丢失不会重复创建；编辑需匹配 version。日志只记录分类与操作 ID，不含原文。

手机 schema v2 独立于桌面 schema 编号，新增 captures/capture_events，重建 sync_outbox 放宽到 save_capture 并复制旧队列。保留 v1 每日任务、历史与队列，未清空数据库。原生开库注册 v1/v2 升级。已查本机安装的 @capacitor-community/sqlite 8.1.1 Android Database.java：升级前复制 backup 数据库、异常恢复、成功删除临时备份。该插件路径仅静态核实，未在 Android 上验证。新增表随 SQLite 整库备份覆盖；面向用户导出恢复仍属 T29。

## 实际验证

- `pnpm typecheck` 通过。
- `pnpm exec vitest run packages/storage-mobile/src/captures.test.ts packages/storage-mobile/src/storage.test.ts`：8 项通过（新增 2 项、旧 6 项）。测试用真实主机 SQLite 文件/内存数据库，非 Android 插件 mock。
- 覆盖：v1 有旧任务时升级、中文原文与换行、编辑、关闭重新打开数据库、旧每日任务仍可读、队列数量、过期编辑拒绝；队列写失败的整个事务回滚；已提交但响应丢失后原操作重试；同操作 ID 不同正文拒绝。
- 主线程负责全套测试与统一代码评审；本记录不重复声称未运行的整套测试通过。

## 未完成与真实阻塞

未生成 APK，未执行 Android 真机测试，没有设备型号/系统版本。主线程环境检查未发现 adb/java 或常见 SDK/JDK 安装位置，用户未提供设备或安装路径；未下载大型 SDK、未部署同步。T22 整体不能标 done；T23/T24 的真机前置仍待验收。后台挂起/杀进程恢复、插件升级失败恢复、磁盘不足、软键盘、安全区、中文输入法和系统字体放大均须实际设备验证。主机 SQLite 结果不替代这些条件。所有同步工单和 AI 均未由本任务执行。

## 环境就绪后的验收

1. 提供匹配现有工程的 JDK、Android SDK（工程 compile/target 36）、已授权 USB 调试的 Android 设备；记录型号与系统版本。
2. 构建 client，再执行 mobile 的 Capacitor sync Android，使用现有 Gradle wrapper assembleDebug，安装生成的调试 APK。
3. 飞行模式录入含中文/多行/首尾空格原文，保存后强制停止应用并重启；原文、版本、待同步队列保持。编辑同一项后重复上述步骤。
4. 升级安装覆盖旧 v1 数据库，确认旧每日任务仍在；失败存储场景重试不新增副本，检查日志无原文。
5. 实测中文选词 Enter、软键盘展开、系统字体放大、窄屏和前后台切换；读失败不能显示成空数据。保存失败草稿不能被切换入口丢弃。
