# wx_cups-web

`wx_cups-web` 是企业微信智能机器人打印网关部署工程。它不修改上游 `hanxi/cups-web` 镜像，而是通过专用普通用户调用其登录与打印 API。

## 已实现的安全边界

- 企业微信 WSS 长连接接收文本、图片、文件和图文混排；SDK 下载时完成媒体 AES 解密。
- SQLite 持久化 `msgid`，重复投递和重启后都不会重新出纸；网络中断时状态为 `uncertain`，绝不自动重发。
- `userid` 白名单、10 分钟 10 次限流、20 MB 限制、格式/MIME/文件头校验、文件名净化，以及固定的 A4/黑白/单面/1 份参数。
- Cookie Jar + CSRF Token 正常登录 `cups-web`；密码只从 Docker Secret 文件读取，不进入日志、镜像层或仓库。

## 部署前准备

1. 在上游 cups-web 管理台创建普通用户 `wecom-gateway`，并更改默认管理员密码。
2. 在 CUPS 创建并验证 `Office_A4` 队列；如队列 URI 不同，修改 `docker-compose.yml` 的 `PRINTER_URI`。
3. 创建 `secrets/cups_web_gateway_password.txt` 与 `secrets/wecom_bot_secret.txt`（该目录已被 Git 忽略），并设置 `WECOM_BOT_ID`、`WECOM_ALLOWED_USERS`。
4. 保留现有 `cups-web` 的设备、驱动和持久卷配置到 Compose 中注释所示的位置。

运行：

```powershell
$env:WECOM_BOT_ID = '你的机器人ID'
$env:WECOM_ALLOWED_USERS = 'zhangsan,lisi'
docker compose up -d --build
```

网关服务名为 `wx_cups-web`，没有 HTTP 入站端口；只建立到企业微信的出站 WSS，并通过内部网络访问 `cups-web`。

本地开发验证：

```powershell
Set-Location .\wx_cups-web
npm install
npm test
npm run check
```

## GHCR 镜像发布

推送 `main`/`master` 或 `v*` 标签会自动构建并发布 `linux/amd64`、`linux/arm64` 多架构镜像到 `ghcr.io/<仓库所有者>/wx_cups-web`；也可以在 GitHub Actions 页面手动运行“构建并发布 GHCR 镜像”工作流。
