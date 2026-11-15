# 建议任务转换与用户账号

2026-10-11 已实现建议任务加入普通清单，以及 Windows / Android 的邮箱注册、登录、退出和按用户隔离数据。现有局域网 HTTPS 后端已更新并重启，健康检查返回 200，账号接口已生效。

## 使用方式

- 桌面“今日与近期”展开“建议任务”，点击“转为普通任务”，原任务加入当前查看日期的上午清单，之后可调整时段、排序、编辑和完成。
- 桌面“设置”或 Android“我的”打开“用户账号”，填写邮箱和密码；注册时填写昵称。密码为 6–128 个字符。
- 已配对设备会自动填写现有服务地址并沿用证书。连接其他自签名 HTTPS 服务时，可在“连接设置”填入服务的 PEM 证书。
- 登录成功后重新打开个人工作空间；退出后返回原本机工作空间。再次登录同一账号恢复该账号的数据，不自动将本机旧内容上传到新账号。

新版 Windows 调试程序：`.tools/releases/accounts-suggestions/Praxis.exe`。
Android 调试 APK：`apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`，已覆盖安装至现有模拟器，保留原有数据。

## 任务转换

新增 `accept_suggestion` 命令，通过原任务 ID 和版本创建每日安排。安排、版本、历史事件和待同步操作在同一事务提交；同一操作重试不会重复创建任务。保留备注、项目、独立计划、真实截止、跟进时间和优先级。成功后建议区不重复显示该任务。

沿用普通安排的可执行范围：未完成叶子任务，所属项目须为活跃且未归档。任务状态或版本已经变化时，拒绝旧操作并提示重新读取。转换不改变等待或阻塞状态。

## 账号与隔离

后端增加 `/auth/register`、`/auth/login`、`/v1/account` 和 `/v1/account/logout`。邮箱按去空格、小写规范化；服务端依据会话推导 owner，客户端提交 owner 字段会被拒绝。实体、快照、变更游标和操作回执均延续 owner 隔离；会话绑定 device，伪造设备不能写入。

密码采用随机盐和 scrypt（N=65536、r=8、p=2），参数参考 [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。后端只保存密码派生值和令牌摘要，会话有效期 30 天；认证入口每 IP 每 15 分钟最多 20 次请求。正常联网退出会撤销当前会话；离线退出仍清除本机凭据，远端未撤销的会话由到期机制失效。

Windows 按服务地址和用户 ID 生成独立账号目录，数据库、备份、恢复指针和同步队列均位于该目录。令牌使用 Windows DPAPI 保存；切换账号重启进程，使原工作空间的编辑状态和异步操作不能进入新工作空间。

Android 使用 Keystore / AES-GCM 保存账号凭据，每个服务地址和用户对应独立 SQLite 文件。WebView 内冻结数据库标识；账号切换后重新加载应用。原生同步请求核对数据库标识，旧工作空间的请求不能借用新账号凭据；开始同步前也核对标识，避免旧数据库被绑定到新账号。

到期后仍可离线使用本机数据，重新登录同一账号后继续同步。当前账号系统接入自建 HTTPS 服务；没有部署公网账号服务，也未进行 Android 物理设备验收。T23 保留云端部署及其他未完成范围。

## 验证

- TypeScript / API / 移动存储：32 个测试文件、144 个测试通过。
- Windows 原生完整测试：144 个测试通过，包括备份、恢复、迁移、任务安排、同步和账号目录隔离。
- 前端类型检查、API 构建、Windows 内置资源调试构建、Android 调试包构建通过。
- 真实 Windows / WebView2：建议任务转入普通清单，原 ID、备注和截止时间保留；注册、登录、退出触发重启，本机/A/B 三个空间互相隔离，重新登录恢复 A，自动同步成功。
- Android 17 模拟器：账号表单与当前用户界面可用；通过原生账号接口验证注册、登录、退出和 WebView 重载，A/B 数据库独立，重新登录恢复 A，旧数据库请求被原生层拒绝，任务实际上传到隔离后端。退出后原本机任务列表与验收前一致。

验收使用独立后端和新建账号。结果与截图见 [Windows 结果](evidence/accounts-suggestions/result.json)、[Android 结果](evidence/accounts-suggestions/mobile-result.json)、[转换前](evidence/accounts-suggestions/suggestion-before.png)、[转换后](evidence/accounts-suggestions/suggestion-after.png)、[Windows 账号](evidence/accounts-suggestions/account-logged-in.png)、[Android 账号](evidence/accounts-suggestions/android-account.png)。测试脚本为 `scripts/native-accounts-suggestions.mjs` 和 `scripts/mobile-accounts.mjs`。
