# Praxis 管理后台

2026-10-18：已在现有 Fastify API 内实现独立管理后台，并部署到现有 ECS，入口为 [线上管理控制台](https://8.152.219.210/admin)。独立管理员密钥已配置，公网登录与原有同步接口验证通过。

## 当前线上状态

- 沿用现有 HTTPS 证书和 443 端口，无需新增服务端口。生产容器 `praxis-api-1` 健康，证书续期定时器保持启用。
- 使用独立随机管理密钥登录，无需用户名。服务器 `server.json` 只保存 SHA-256 哈希；原始密钥交付到本机 Git 忽略目录 `.tools/admin-login.txt`，文件权限已限定为当前 Windows 用户可读写，不在代码、日志或本记录中保存明文。
- 镜像版本 `praxis-api:admin-20261018T114805Z`；更新前镜像保留为 `praxis-api:before-admin-20261018T114805Z`。
- 完整备份位于 ECS `/opt/praxis/backups/before-admin-20261018T114805Z`，包含更新前源代码、运行配置和一致的 SQLite 数据备份，目录只允许 root 访问。
- 切换前后原有 3 个账号、3 个应用会话、15 个同步对象、11 个同步操作批次保持一致，原有账号身份及密码字段未改变，SQLite 完整性检查通过。
- 公网检查覆盖 HTTPS 证书、后台入口、未登录拦截、管理员登录与退出、Secure/HttpOnly/SameSite Cookie、全部后台页面、普通账号权限隔离、注册登录与同步。临时验收账号及其会话、同步数据和历史已按精确账号 ID 清理。
- 公网验收记录见 [verification.json](evidence/admin-ecs/verification.json)，部署记录见 [deployment.json](evidence/admin-ecs/deployment.json)。

## 功能

- 数据概览：注册账号、正常账号、有效登录设备、未删除的云端数据对象，以及最近 14 天同步写入趋势。
- 用户管理：按名称、邮箱或用户 ID 搜索，按正常/禁用状态筛选，分页，导出当前页 CSV。
- 用户详情：账号状态、注册及最近登录时间、各类数据数量、有效登录设备。支持撤销单个设备或全部应用账号登录，启用/禁用账号；变更必须填写原因并确认。
- 同步数据：任务、项目、收集、习惯、安排、记录等全域对象的数量及累计写入批次。
- 操作日志：管理员登录、账号启用/禁用、登录撤销的时间、目标账号及原因。
- 系统状态：运行时长、同步协议、服务代次、数据库大小、Node.js 版本及管理会话配置。

所有统计来自当前 API 使用的 SQLite；没有内置演示用户或虚构业务指标。有效设备指尚未过期的账号登录会话，按用户和设备去重，不代表实时在线。趋势以 UTC 自然日统计成功接收的操作批次，不包含拉取请求。SQLite 大小不包含 WAL 文件。旧账号没有历史注册和登录时间，显示「未记录」，不推算历史数据。

后台只返回账号信息、设备 ID 与数据统计，不返回用户任务正文、记录内容、密码哈希或会话令牌。当前为单个管理员凭据，不提供多管理员角色分配。

## 本地查看

需要项目现有 Node.js 和 pnpm 环境。在 PowerShell 中设置至少 32 个字符的管理密钥，然后运行：

```powershell
$env:PRAXIS_ADMIN_TOKEN = Read-Host "输入至少 32 个字符的管理密钥"
pnpm admin:preview
```

打开 `http://127.0.0.1:4319/admin`，使用刚设置的密钥登录。预览只监听本机，使用独立的 `.tools/admin-preview/api.db`，首次启动显示真实空状态；不连接云端数据库。关闭预览终端即可停止。密钥不在程序日志中输出。

## 接入现有 HTTPS 部署

后台随 API 一起构建并由同一个 HTTPS 服务提供，不需要额外前端服务或端口。现有 Dockerfile 会打包页面、脚本、样式及图标。

在服务的私有 `server.json` 中增加 `adminTokenHash`，值为管理员原始密钥的 SHA-256 十六进制哈希（64 位）。原始密钥应随机生成并安全保管；服务器配置与代码仓库只存哈希。不要把真实密钥或配置提交到仓库。可在本机通过以下方式生成并把结果分别保存到密码管理器和服务器私有配置：

```powershell
node -e "const c=require('node:crypto');const token=c.randomBytes(32).toString('hex');console.log('管理密钥：'+token);console.log('adminTokenHash：'+c.createHash('sha256').update(token).digest('hex'))"
```

维护人员执行上述命令时会明确显示一次密钥；应用本身不会输出密钥。也支持服务进程环境变量 `PRAXIS_ADMIN_TOKEN`（至少 32 个字符），优先于配置哈希；当前 Compose 不透传该变量，Docker 部署优先使用挂载的 `server.json`。

更新前按 [ECS 部署说明](deploy-ecs.md) 备份数据库与配置，再重新构建并重启服务。更新后访问同一服务的 `/admin`。未配置管理员凭据时，页面可访问但所有后台接口返回 `503 ADMIN_NOT_CONFIGURED`，无默认管理员或默认密码。

管理员会话有效期 8 小时，令牌仅以哈希保存；浏览器使用 HttpOnly、SameSite=Strict Cookie，HTTPS 下同时设置 Secure。写操作需携带同源请求头；登录有独立的尝试次数限制。轮换 `adminTokenHash` 并重启后，旧管理会话失效。退出登录会立即撤销该管理会话。

禁用账号会撤销其全部应用会话并阻止登录和同步；启用后需重新登录。固定配对凭据若对应已禁用的账号，也无法继续同步。「撤销登录」只针对邮箱账号会话；历史固定配对凭据需在服务器配置中维护。

## 数据迁移与验证

首次启动为 `account_users` 增加 `disabled`、`created_at`、`last_login_at` 列，并建立 `admin_sessions`、`admin_audit` 表。旧账号默认启用，密码与已有会话保留。账号状态变更、会话撤销和审计记录共用同一个 SQLite 事务。

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm test:admin
```

`test:admin` 使用临时 SQLite、临时随机管理密钥和本机临时端口，创建测试账号并走实际浏览器交互，不连接生产服务。Windows 优先使用已安装的 Edge；其他环境需提供 Playwright Chromium。验证后关闭自己的浏览器和 API，清理临时数据库。证据保存到 `docs/evidence/admin`，截图中的账号仅为本地测试数据。

接口覆盖：未配置/未授权/普通用户越权拦截、输入验证、登录限流、统计与内容隔离、搜索分页、禁用与恢复、单设备及全设备撤销、会话持久化/退出/过期/密钥轮换、旧数据库迁移。浏览器覆盖：登录、空状态、概览、搜索、分页、导出、详情、账号启停确认、旧会话失效、状态筛选、全部页面、手机导航和退出。

本轮验证结果：35 个测试文件、158 项测试全部通过；类型检查、客户端构建与 API 构建通过；11 项实际浏览器交互验证通过，无浏览器报错。另验证了密码校验过程中禁用账号的并发情况，以及审计写入失败时账号状态和会话删除一起回滚。浏览器验证记录见 [verification.json](evidence/admin/verification.json)，[桌面截图](evidence/admin/overview.png) 与 [手机截图](evidence/admin/overview-mobile.png) 均使用隔离的本地测试数据。
