# ECS Docker 部署

2026-11-06 更新：用户确认域名备案完成，备案号为 **陕ICP备2026010048号**（用户提供）。当前推荐后端为 `https://todo.frostraven05.com`，管理后台为 `https://todo.frostraven05.com/admin`。已签发同时包含 `todo.frostraven05.com` 和 `8.152.219.210` 的公开信任证书，保留 IP HTTPS 供现有客户端连接。Windows 与 Android 模拟器通过域名完成注册、登录、双向任务与完成状态同步，以及进程重启验收，见 [本轮结果](evidence/domain-https/result.json)。域名版 Windows / Android 程序在 `.tools/releases/domain-https/`。

已有登录账号继续使用其原服务地址及本机工作空间，新注册或未登录时默认域名；本轮没有强制迁移旧账号地址或复制用户本机数据库。证书配置变更前的服务器备份在 `/opt/praxis/backups/tls-domain-20261106T142026Z`。后文 10 月 18 日内容保留为原 IP 部署历史。

当前续期已改为 **webroot**：ECS 上现有 Nginx 保持运行，新增独立的 `deploy/praxis-acme.conf` 虚拟主机，为域名和 IP 提供 `/var/www/letsencrypt/.well-known/acme-challenge/` 验证文件。Certbot `reconfigure --cert-name praxis-ecs-ip --authenticator webroot --webroot-path /var/www/letsencrypt --non-interactive --no-random-sleep-on-renew` 已通过测试续期并永久保存。原每日两次的 `praxis-certificate-renew.timer` 与证书复制部署钩子继续使用；不要再按下文历史命令切回 standalone。现有 `frostraven05.com` / `www.frostraven05.com` Nginx 配置未被替换。新增配置前的备份保存在服务器 `/opt/praxis/backups/acme-webroot-*`。

本配置部署 Windows / Android 使用的账号与同步 API，不提供浏览器任务应用。

2026-10-18：同一服务已增加独立的 [管理后台](https://8.152.219.210/admin)，管理员登录已配置。后台只展示账号、同步统计和管理操作；部署备份及公网验收见 [管理后台记录](implementation-admin.md)。

## 2026-10-18 初始部署

- ECS：`8.152.219.210`，北京，`i-2zee4ny1lv9woz0s9jvk`，Alibaba Cloud Linux 4 x86_64。
- 当前服务地址：`https://8.152.219.210`；健康检查：`https://8.152.219.210/health`。
- 项目目录：`/opt/praxis`；持久化数据：`/opt/praxis/deploy/runtime/data`。
- 容器：`praxis-api-1`，以 `node` 用户运行，宿主机 443 映射容器 4318。Docker 开机启动，容器 `unless-stopped` 自动重启。
- 证书：Let's Encrypt 公开信任 IP 证书，SAN 为 `8.152.219.210`，当前有效期至 2026-10-25；采用 shortlived 配置，`praxis-certificate-renew.timer` 每天检查两次，仅续期 `praxis-ecs-ip`，成功续期后复制证书并重启 API。
- 安全组：用户明确授权后增加 TCP 443 公网入站；未对公网开放 4318。80 端口原有规则用于证书域名验证。
- 此为独立新数据库，没有迁移开发电脑的数据。客户端需将后端地址设为上述 HTTPS IP，使用应用账号注册或登录；ECS root 密码不是应用登录密码。

服务器 `.env` 设置 `PRAXIS_HTTPS_PORT=443` 与 `PRAXIS_NODE_IMAGE=public.ecr.aws/docker/library/node:24-bookworm-slim`。Docker Hub 从该 ECS 访问超时，实际使用 Docker 在 Amazon ECR 发布的官方 Node 镜像。

证书工具安装在独立环境 `/opt/praxis-certbot`，当前证书目录 `/etc/letsencrypt/live/praxis-ecs-ip`。续期服务配置见仓库 `deploy/praxis-certificate-renew.*`，部署钩子为 `deploy/renew-certificate.sh`。保留宿主机 80 端口供 Certbot standalone 验证；不要部署占用 80 的其他服务而不调整续期方案。

截至 2026-10-18，镜像在 ECS 构建并启动，容器健康检查和本机至公网 IP 的证书校验通过。真实 HTTPS 注册、登录、退出、未登录拦截和容器重启后账号持久化验收通过。后续 Windows 与 Android 模拟器的真实双端登录、任务同步和客户端重启验收亦已通过，见 [双端验收记录](implementation-ecs-clients.md)。

最初域名 `todo.frostraven05.com` 的证书签发及健康检查曾通过，后续公网访问被阿里云 `Non-compliance ICP Filing` 页面及 TLS 重置拦截。用户选择保留该域名处理备案，同时明确授权暂用 IP；两端因此改为 IP HTTPS，没有关闭证书或主机名校验。原域名证书保留在 `/etc/letsencrypt/live/todo.frostraven05.com`，不再作为当前 API 的服务证书。域名完成接入后，需再切换服务证书及客户端地址；账号工作空间按地址隔离，届时应安排迁移，避免直接切换后误以为旧本机数据丢失。

当前 IP 证书已通过 `certbot renew --cert-name praxis-ecs-ip --dry-run --no-random-sleep-on-renew` 续期演练；部署钩子复制正式证书并重启容器亦已实际验证。

## 服务器准备

使用已安装 Docker Engine 与 Compose 插件的 Linux ECS。将项目源代码上传到独立目录，避免覆盖服务器已有服务。镜像构建仅包含 API 源码，不包含本机数据库、密钥或开发证书。

在该目录执行：

```sh
mkdir -p deploy/runtime/config deploy/runtime/data
cp deploy/server.example.json deploy/runtime/config/server.json
```

将域名有效的 TLS 私钥及完整证书链分别放置为 `deploy/runtime/config/server.key` 和 `fullchain.pem`，将健康检查使用的可信根 CA PEM 放为 `health-ca.crt`。将配置中的 `healthServerName` 改为证书中的真实域名。正式证书续期后需重启 API 以重新加载证书。

本次 ECS 已使用 Certbot 5.8 申请 IP 证书，并由续期钩子完成证书复制。签发命令：

```sh
/opt/praxis-certbot/bin/certbot certonly --standalone --non-interactive --agree-tos --register-unsafely-without-email --preferred-profile shortlived --ip-address 8.152.219.210 --cert-name praxis-ecs-ip
```

原始证书及 CA 账号保存在 `/etc/letsencrypt`，不要将它们上传到代码仓库。IP 证书有效期较短，须保持续期定时器运行并检查错误日志。官方说明：[Certbot 的短期与 IP 证书](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)。

容器以 UID/GID 1000 运行；确保该用户可读配置、私钥和证书，可写数据目录：

```sh
sudo chown -R 1000:1000 deploy/runtime
chmod 700 deploy/runtime/config deploy/runtime/data
chmod 600 deploy/runtime/config/*
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 api
curl --fail https://sync.example.com:4318/health
```

`devices: []` 支持邮箱注册登录；若迁移已有配对设备，须保留原 `devices` 凭据哈希。迁移原数据库前停止旧后端，备份并复制数据库及其 WAL/SHM 文件到数据目录，不要直接复制正在写入的数据库主文件。客户端服务地址需改为新 HTTPS 地址。

阿里云安全组与系统防火墙仅按实际客户端来源开放 TCP 4318；SSH 仅允许管理来源。可用 `PRAXIS_BIND_ADDRESS` 将发布端口限定到 ECS 指定网卡。云访问密钥不属于应用运行配置，不应放入服务器配置、镜像或仓库。

## 备份与更新

```sh
docker compose stop api
tar -czf praxis-backup-$(date +%Y%m%d-%H%M%S).tar.gz deploy/runtime
docker compose start api
```

备份包含私钥和用户数据，应限制访问并保存到独立位置。更新前先备份，再运行 `docker compose up -d --build`，检查容器健康状态和公网 HTTPS。回退须使用上一版镜像；若数据库结构已变化，配套恢复更新前备份。

ECS 灾难恢复还需单独备份 `/etc/letsencrypt`、服务器 `.env` 与续期任务配置。运行 `systemctl list-timers praxis-certificate-renew.timer` 检查续期计划；使用 `journalctl -u praxis-certificate-renew.service` 查看续期错误。

环境安装参考：[阿里云 Docker 安装说明](https://www.alibabacloud.com/help/en/ecs/user-guide/install-and-use-docker)、[Docker 官方镜像目录](https://gallery.ecr.aws/docker/)、[Certbot 安装与续期说明](https://certbot.eff.org/instructions?os=pip&ws=other)。
