# 双端连接 ECS 与登录同步验收

2026-11-06：备案完成后，双端未登录时的默认地址已更新为 `https://todo.frostraven05.com`。域名版程序位于 `.tools/releases/domain-https/`；Windows 与 Android 17 模拟器的真实注册、登录、双向创建、完成状态同步、重启保持及退出后本机任务保留均已通过。结果位于 [域名验收记录](evidence/domain-https/result.json)。服务证书兼容域名及原 IP；已有登录账号保持原地址，避免自动切换工作空间。下文为此前 IP 地址验收历史。

2026-10-18，Windows 与 Android 的默认账号服务地址已设为 `https://8.152.219.210`。该 IP 使用 Let's Encrypt 有效 IP 证书，客户端使用正常证书链和主机名验证，不需要导入私有 CA。

原计划域名 `todo.frostraven05.com` 的公网访问被阿里云返回 `Non-compliance ICP Filing` 拦截。用户选择保留域名办理接入，同时暂用 IP，因此当前无需等待域名处理即可登录同步。

## 程序与数据

- Windows 内置资源调试程序：`.tools/releases/ecs-cloud/Praxis.exe`。
- Android 调试 APK：`apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`，已覆盖安装到现有 `emulator-5554`，保留应用数据。
- 尚未登录时，两端账号表单默认 IP HTTPS 地址；已有账号保留原服务地址，避免将其他服务的会话或数据错误绑定到此 ECS。
- 登录同一云端账号后，Windows DPAPI 与 Android Keystore 各自保存会话，进入该账号独立的本地数据库。本机原有内容不会自动并入云端账号。

## 实际验证

运行 `node scripts/ecs-dual-client-smoke.mjs`，使用真实 Tauri/WebView2 与 Android 17 模拟器，账号注册和登录通过界面进行，任务写入也通过客户端界面进行，没有直接向后端或数据库注入业务数据。

通过项目：

1. 两端默认 IP 地址正确，使用系统信任证书连接。
2. Windows 注册、退出、重新登录；Android 登录同一云端账号。
3. Windows 界面创建的任务通过 ECS 自动同步，在 Android 界面恰好出现一次。
4. Android 界面创建的任务通过 ECS 自动进入 Windows 原生存储。
5. Android 完成 Windows 创建的任务，完成状态自动同步回 Windows。
6. 重启两端真实进程，登录状态、任务及完成状态保留，Windows 同步恢复在线。
7. 测试结束退出验收账号，Android 原本机任务列表与验收前一致。Windows 使用独立测试数据目录，没有切换或修改用户原有桌面工作空间。

结果与截图：[结果](evidence/ecs-clients/result.json)、[桌面账号](evidence/ecs-clients/desktop-account.png)、[Android 账号](evidence/ecs-clients/android-account.png)、[桌面任务](evidence/ecs-clients/desktop-tasks.png)、[Android 任务](evidence/ecs-clients/android-tasks.png)。验收密码仅在内存中生成，不进入结果或文档；验收账号服务器数据与用户数据隔离。

本次覆盖 Windows 与 Android 模拟器，未连接实体手机，也不代表所有业务对象或离线冲突场景的完整回归。既有全域同步范围见 [原同步记录](implementation-full-sync.md)。
