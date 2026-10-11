# 局域网开发后端

2026-10-11 按用户要求先建立局域网服务。现有电脑部署地址为 `https://192.168.5.56:4318`，端口只绑定该私网地址。电脑须开机且保持此地址；未配置开机自启。

后续同日已完成 Windows/Android 收集项接入，见 [双端同步记录](implementation-lan-clients.md)。下文的“App 尚未接入”描述为后端首次交付时的范围，最新状态以该记录为准。

## 当前能力与边界

- Fastify + Node.js 22.15 内置 SQLite；数据库独立于桌面和手机本地库。此为局域网开发部署，云端 PostgreSQL + Supabase Auth 技术路线未被替换。
- 独立设备 Bearer 令牌在服务端映射 owner/device；客户端不能指定 owner。初始两个开发设备属于同一开发用户，不是邮箱登录或可公开注册的账号系统。
- 收集项命令支持版本检查、精确幂等回执、原文 Unicode/换行、删除墓碑；内容、版本、回执、用户独立递增游标在同一 SQLite 事务提交。
- 过期版本返回 409，不覆盖内容；目前没有保存双方值的完整冲突工作流。客户端接入时必须保留未确认命令，不能将 409 当作上传成功。
- 每设备每分钟 240 请求、请求体 1 MiB、原文非空且最多 100000 Unicode 字符。服务不输出请求正文或令牌。
- 只提供收集项接口，没有任务/项目全域同步。手机和桌面 App 尚未连接此服务；本次不能关闭 T23/T25–T28。

## 启停与检查

在仓库根目录 PowerShell 执行（首次先 `pnpm install`）：

```powershell
./scripts/start-lan.ps1 -LanAddress 192.168.5.56
node scripts/check-lan.mjs
./scripts/stop-lan.ps1
```

启动会创建或复用 `.tools/lan`，构建 API 并后台运行；重复启动遇到已有监听会停止，不杀别的进程。停止脚本核对进程名和入口路径后才停止，保留数据。独立前台启动可使用 `pnpm --filter @praxis/api start`；配置默认定位仓库 `.tools/lan/server.json`，也可用 `PRAXIS_LAN_CONFIG` 指定配置绝对路径。

本次已以管理员权限创建 Windows 防火墙规则 `Praxis-LAN-HTTPS-4318`，限定 Node 程序、WLAN 接口、本机 `192.168.5.56`、TCP 4318、来源 `LocalSubnet`。未改变网络的公用/专用类别，未设置路由器端口转发。首次换机器时由管理员运行：

```powershell
./scripts/allow-lan.ps1 -LanAddress 192.168.5.56
```

移除此服务的防火墙例外（管理员）：`Remove-NetFirewallRule -Name Praxis-LAN-HTTPS-4318`。

## 本地数据与证书

| 路径（相对仓库） | 用途 |
| --- | --- |
| `.tools/lan/praxis.sqlite` | 服务端收集项、墓碑、完整回执/变更记录 |
| `.tools/lan/server.json` | 绑定地址、数据库路径、设备令牌哈希 |
| `.tools/lan/clients.json` | 开发设备令牌，仅用于后续受控配对/本机测试 |
| `.tools/lan/ca.crt` | 开发 CA 公共证书，可供客户端显式信任 |
| `.tools/lan/ca.key`、`server.key` | 私钥，仅保留在后端电脑 |
| `.tools/lan/connection.json` | 服务地址及 CA SHA-256 指纹，无令牌 |
| `.tools/lan/stdout.log`、`stderr.log` | 运行日志；没有请求正文日志 |

这些文件由 `.gitignore` 排除。启动前目录 ACL 限当前 Windows 用户及 SYSTEM；私钥和设备令牌不进入 APK、Git 或文档。备份时先停止服务，再复制整个 `.tools/lan` 到私密备份位置；恢复完整目录后再启动，勿只复制运行中的数据库主文件而遗漏 WAL。

HTTPS 使用本机生成的开发 CA 和包含 LAN IP 的服务证书。检查脚本显式信任此 CA，并验证主机名；没有跳过 TLS 校验或安装系统全局根证书。普通浏览器/当前 App 尚未信任此 CA，因此不是点开网址即可直接使用的网页应用。App 接入时需要限定服务的证书信任及安全令牌存储，不能用关闭证书验证解决。

地址变化时启动脚本会拒绝悄悄替换现有配置：需保留数据库及设备凭据，更新 host、服务证书 SAN、连接地址及对应防火墙规则。CA 有效期 10 年，服务证书 1 年；目前未实现自动续期。

## API v1

`GET /health` 无认证，返回服务名、协议版本和状态。其余请求使用 `Authorization: Bearer <本地设备令牌>`，令牌不要写入 URL。

`POST /v1/captures/commands`：

```json
{
  "operationId": "唯一 UUID，重试必须原样复用",
  "deviceId": "令牌所属设备 UUID",
  "id": "收集项 UUID",
  "expectedVersion": null,
  "rawText": "原文，保留空格和换行",
  "deleted": false
}
```

新建 expectedVersion 为 null；修改/删除为当前版本。UUID 字段示意文字必须换成真实 UUID。成功返回 `{capture, cursor}`；重复原命令返回原回执。相同 operationId 改内容为 409，旧版本及墓碑编辑也为 409。删除不能自动复活。

`GET /v1/captures/changes?after=0&limit=100` 返回 `{changes, cursor, hasMore}`，limit 1–100，cursor 为该用户已返回的最后一条变更。客户端仅在本地实体与游标一起成功提交后推进游标，服务端不代替客户端保障这一点。

## 验证记录

- 全仓类型检查、API 编译通过；完整 Vitest 20 文件、81 测试通过（API 7 项）。
- API 集成覆盖未认证、伪造设备、跨 owner 相同 ID 隔离、Unicode 原文、空白拒绝、精确重试、CAS、墓碑、分页和数据库重开。
- `node scripts/check-lan-sync.mjs` 用本机两个开发设备身份经过真实 HTTPS 上传、拉取、重复请求、过期版本和删除后编辑；验收内容最终为墓碑，证据 `docs/evidence/lan/https-smoke.json`。这不是两端 App 同步验收。
- 服务实际停止/重启后健康检查和 HTTPS API 复验通过，旧配置未替换，变更游标从 3 继续至 6。
- Android 模拟器 `emulator-5554` 到 `192.168.5.56:4318` 的 TCP 连接通过；尚未验证物理手机及 App 的 HTTPS/证书信任。
- Standards 审查发现空白原文缺少校验，已修复并补测试；Spec 审查未发现本轮基础接口范围内确定性缺陷。

后续顺序：App 安全配对/设备令牌存储 → 收集项 outbox 上传及原子拉取 → Windows/Android 实际双端验收 → 项目/任务统一协议与冲突处理。AI 保持暂停。

实现参考：[Fastify HTTPS/监听配置](https://fastify.dev/docs/latest/Reference/Server/)、[Node SQLite](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html)。
