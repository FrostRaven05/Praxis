# 局域网开发后端

2026-10-11 按用户要求先建立局域网服务。现有电脑部署地址为 `https://192.168.5.56:4318`，端口只绑定该私网地址。电脑须开机且保持此地址；未配置开机自启。

同日后续已完成 Windows/Android 全域协议接入，最新客户端范围和实际验收见 [全域双端同步记录](implementation-full-sync.md)。下文保留 v1 收集项接口及早期测试作为升级记录。

## 当前能力与边界

- Fastify + Node.js 22.15 内置 SQLite；数据库独立于桌面和手机本地库。此为局域网开发部署，云端 PostgreSQL + Supabase Auth 技术路线未被替换。
- 独立设备 Bearer 令牌在服务端映射 owner/device；客户端不能指定 owner。初始两个开发设备属于同一开发用户，不是邮箱登录或可公开注册的账号系统。
- 全域实体命令支持版本检查、精确幂等回执、关联对象原子批次和删除墓碑；内容、版本、回执、用户独立递增游标在同一 SQLite 事务提交。
- 有真实共同基线时，不同字段三方合并；同字段不同值返回冲突，客户端保留双方并显式解决。父子、项目下一步、关联及历史规则同时校验，409 不表示上传成功。
- 每设备每分钟 240 请求；全域命令请求体上限 8 MiB、单批最多 10,000 变更。拉取按完整批次分页，页面上限 15 MiB；这些限制不代表已完成 T30 的规模性能验收。服务不输出请求正文或令牌。
- Windows 运行期间及 Android 前台自动发送/拉取，覆盖所有非 AI 核心实体。T23 云登录、物理设备与发布验收仍未完成。

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
| `.tools/lan/praxis.sqlite` | 服务端全域实体、墓碑、完整回执/变更记录及历史收集项数据 |
| `.tools/lan/server.json` | 绑定地址、数据库路径、设备令牌哈希 |
| `.tools/lan/clients.json` | 开发设备令牌，仅用于后续受控配对/本机测试 |
| `.tools/lan/ca.crt` | 开发 CA 公共证书，可供客户端显式信任 |
| `.tools/lan/ca.key`、`server.key` | 私钥，仅保留在后端电脑 |
| `.tools/lan/connection.json` | 服务地址及 CA SHA-256 指纹，无令牌 |
| `.tools/lan/stdout.log`、`stderr.log` | 运行日志；没有请求正文日志 |

这些文件由 `.gitignore` 排除。启动前目录 ACL 限当前 Windows 用户及 SYSTEM；私钥和设备令牌不进入 APK、Git 或文档。备份时先停止服务，再复制整个 `.tools/lan` 到私密备份位置；恢复完整目录后再启动，勿只复制运行中的数据库主文件而遗漏 WAL。

HTTPS 使用本机生成的开发 CA 和包含 LAN IP 的服务证书。检查脚本及配对 App 显式信任此 CA，并验证主机名；没有跳过 TLS 校验或安装系统全局根证书。普通浏览器不会因此自动信任此 CA，服务也不提供点开网址即可使用的网页应用。桌面凭据由 DPAPI、手机由 Android Keystore 保护；配对步骤见 [客户端记录](implementation-lan-clients.md#配对和隔离)。

地址变化时启动脚本会拒绝悄悄替换现有配置：需保留数据库及设备凭据，更新 host、服务证书 SAN、连接地址及对应防火墙规则。CA 有效期 10 年，服务证书 1 年；目前未实现自动续期。

## 当前全域实体 API

协议详情见 [entity-protocol.md](../apps/api/src/entity-protocol.md)。所有业务请求仍通过设备 Bearer 令牌认证，服务端从令牌确定 owner。

- `POST /v1/entities/commands?generation=<当前服务实例>`：持久化冻结的 `operationId`、`deviceId` 和 `changes`，每个变更包含身份、类型、期望版本、数据、墓碑和创建时刻，可携带共同基线。完整批次成功后才产生一个游标；重试必须原样复用逻辑请求。
- `GET /v1/entities/changes`：用户隔离的原子批次增量页，不拆开同一次业务命令。
- `GET /v1/entities/snapshot`：固定游标的一致快照，可分页。服务每次启动产生新 generation；客户端先保护未发送操作，再取得快照重建影子并重放，不能清空业务库。

实体种类为 capture、task、project、section、plan、record、habit、habit_check、recurrence、review、view、settings、strategy、decision、focus 和桌面辅助 desktop_row。辅助实体保留桌面排序、依赖、规则历史等关系。移动端编辑保留未知字段；不同端的默认值、优先级和日期映射在适配层统一。

## 历史收集项 API v1

以下为第一轮接口。全域升级后仍可读取旧变更，但写入返回 `PROTOCOL_UPGRADED`，避免旧客户端与全域迁移并发写出两个不一致来源。当前客户端使用上面的实体协议。

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

## 第一轮验证记录

- 全仓类型检查、API 编译通过；完整 Vitest 20 文件、81 测试通过（API 7 项）。
- API 集成覆盖未认证、伪造设备、跨 owner 相同 ID 隔离、Unicode 原文、空白拒绝、精确重试、CAS、墓碑、分页和数据库重开。
- `node scripts/check-lan-sync.mjs` 用本机两个开发设备身份经过真实 HTTPS 上传、拉取、重复请求、过期版本和删除后编辑；验收内容最终为墓碑，证据 `docs/evidence/lan/https-smoke.json`。这不是两端 App 同步验收。
- 服务实际停止/重启后健康检查和 HTTPS API 复验通过，旧配置未替换，变更游标从 3 继续至 6。
- Android 模拟器 `emulator-5554` 到 `192.168.5.56:4318` 的 TCP 连接通过；尚未验证物理手机及 App 的 HTTPS/证书信任。
- Standards 审查发现空白原文缺少校验，已修复并补测试；Spec 审查未发现本轮基础接口范围内确定性缺陷。

后续全域协议已覆盖身份隔离、批次约束、共同历史基线、墓碑、幂等重试和服务 generation 变化；实际双端证据与最终测试数量见 [全域记录](implementation-full-sync.md)。后续交付包括云账号登录、发布版配对、物理设备和规模性能验收。AI 保持暂停。

实现参考：[Fastify HTTPS/监听配置](https://fastify.dev/docs/latest/Reference/Server/)、[Node SQLite](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html)。
