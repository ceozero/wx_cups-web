# wx_cups-web

`wx_cups-web` 是微信客服打印网关：个人微信用户通过微信客服发送文字、图片或文件，网关验证并调用现有 `cups-web` 提交打印。不会修改或替换上游 `hanxi/cups-web` 镜像。

## 功能与安全边界

- 通过企业微信「微信客服」的加密 HTTPS 回调接收事件，并调用 `kf/sync_msg` 拉取文本、图片和文件。
- SQLite 持久化 `msgid` 与消息游标；重复投递、网关重启、网络超时均不会自动重复出纸。
- `external_userid` 白名单、10 分钟 10 次限流、20 MB 限制、文件头/扩展名校验、文件名净化，以及固定 A4/黑白/单面/1 份参数。
- Cookie Jar + CSRF Token 登录 `cups-web`；全部凭据只由环境变量提供，绝不写入日志、镜像或仓库。
- 仅处理来自个人微信客户的消息；系统事件和企业微信坐席消息不会被误提交打印。每个客户消息只发送一条最终回执，客服回执失败仅记录错误，不会造成网关进程退出。

## 企业微信侧配置

1. 在企业微信管理后台开通「微信客服」，创建客服帐号并取得其 `open_kfid`。
2. 在「微信客服应用」开启 API，授权该客服帐号由 API 管理，记录 CorpID、微信客服 Secret。
3. 配置回调 URL：`https://你的域名/wecom/kf/callback`；回调服务实际监听端口默认为 `3000`。记录 Token 与 EncodingAESKey。
4. 反向代理必须将该路径转发到宿主机 `127.0.0.1:3000`；企业微信需要能通过公网 HTTPS 访问它。
5. 用户先向客服发一条消息，从网关的 `wecom_kf_ignored_sender` 日志取得其 `external_userid`，填入白名单后重启服务。

## 部署

在上游 cups-web 中创建普通用户 `wecom-gateway`，并确认 CUPS 队列 URI。设置环境变量后运行 Compose：

```bash
export CUPS_WEB_PASSWORD='cups-web 专用用户密码'
export PRINTER_URI='http://127.0.0.1:631/printers/Office_A4'
export WECOM_CORP_ID='wwxxxxxxxxxxxxxxxx'
export WECOM_KF_SECRET='微信客服 Secret'
export WECOM_CALLBACK_TOKEN='回调 Token'
export WECOM_CALLBACK_ENCODING_AES_KEY='43 位 EncodingAESKey'
export WECOM_OPEN_KF_IDS='wkxxxxxxxxxxxxxxxx'
export WECOM_ALLOWED_EXTERNAL_USERS='wmxxxxxxxxxxxxxxxx'
docker compose up -d --build
```

网关使用 host 网络，通过 `127.0.0.1:1180` 访问独立运行的 cups-web；如需其他地址，设置 `CUPS_WEB_URL`。SQLite 数据保存到项目的 `./data`。

首次部署时，若日志报 `unable to open database file`，请在 Compose 文件目录执行：

```bash
sudo mkdir -p data
sudo chown -R 1000:1000 data
docker compose up -d --force-recreate
```

新版镜像会在启动时自动修正绑定目录的容器内所有权。

## 本地验证与 GHCR

```powershell
Set-Location .\wx_cups-web
npm install
npm test
npm run check
```

推送 `main`/`master` 或 `v*` 标签会自动构建并发布 `linux/amd64`、`linux/arm64` 镜像到 `ghcr.io/<仓库所有者>/wx_cups-web`。
