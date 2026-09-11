# wx_cups-web

`wx_cups-web` 是企业微信智能机器人打印网关部署工程。它不修改上游 `hanxi/cups-web` 镜像，而是通过专用普通用户调用其登录与打印 API。

## 已实现的安全边界

- 企业微信 WSS 长连接接收文本、图片、文件和图文混排；SDK 下载时完成媒体 AES 解密。
- SQLite 持久化 `msgid`，重复投递和重启后都不会重新出纸；网络中断时状态为 `uncertain`，绝不自动重发。
- `userid` 白名单、10 分钟 10 次限流、20 MB 限制、格式/MIME/文件头校验、文件名净化，以及固定的 A4/黑白/单面/1 份参数。
- Cookie Jar + CSRF Token 正常登录 `cups-web`；凭据由运行环境变量提供，不写入仓库或日志。

## 部署前准备

1. 在上游 cups-web 管理台创建普通用户 `wecom-gateway`，并更改默认管理员密码。
2. 在 CUPS 创建并验证 `Office_A4` 队列；如队列 URI 不同，修改 `docker-compose.yml` 的 `PRINTER_URI`。
3. 设置 `CUPS_WEB_PASSWORD`、`WECOM_BOT_ID`、`WECOM_BOT_SECRET`、`WECOM_ALLOWED_USERS` 和 `PRINTER_URI` 环境变量。
4. 确认独立运行的 `cups-web` 也使用 host 网络，并在本机 `127.0.0.1:8080` 可访问；需要其他地址时设置 `CUPS_WEB_URL`。

运行：

```powershell
$env:WECOM_BOT_ID = '你的机器人ID'
$env:WECOM_BOT_SECRET = '你的机器人Secret'
$env:CUPS_WEB_PASSWORD = 'cups-web专用用户密码'
$env:WECOM_ALLOWED_USERS = 'zhangsan,lisi'
$env:PRINTER_URI = 'http://127.0.0.1:631/printers/Office_A4'
docker compose up -d --build
```

网关服务名为 `wx_cups-web`，使用 host 网络，没有 HTTP 入站端口；只建立到企业微信的出站 WSS，并通过 `127.0.0.1` 访问独立运行的 `cups-web`。SQLite 数据保存在项目的 `./data`。

本地开发验证：

```powershell
Set-Location .\wx_cups-web
npm install
npm test
npm run check
```

## GHCR 镜像发布

推送 `main`/`master` 或 `v*` 标签会自动构建并发布 `linux/amd64`、`linux/arm64` 多架构镜像到 `ghcr.io/<仓库所有者>/wx_cups-web`；也可以在 GitHub Actions 页面手动运行“构建并发布 GHCR 镜像”工作流。
