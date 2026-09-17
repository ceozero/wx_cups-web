# wx_cups-web

`wx_cups-web` 是微信客服打印网关：个人微信用户通过微信客服发送文字、图片或文件，网关验证并调用现有 `cups-web` 提交打印。不会修改或替换上游 `hanxi/cups-web` 镜像。

## 功能与安全边界

- 通过企业微信「微信客服」的加密 HTTPS 回调接收事件，并调用 `kf/sync_msg` 拉取文本、图片和文件。
- SQLite 持久化 `msgid` 与消息游标；重复投递、网关重启、网络超时均不会自动重复出纸。
- `external_userid` 白名单、10 分钟 10 次限流、20 MB 限制、文件头/扩展名校验、文件名净化，以及固定 A4/黑白/单面/1 份参数。
- Cookie Jar + CSRF Token 登录 `cups-web`；全部凭据只由环境变量提供，绝不写入日志、镜像或仓库。
- 网关会在 cups-web 会话或 CSRF Cookie 过期后自动重新登录；不会自动重发已发出的打印提交，避免重复出纸。
- 仅处理来自个人微信客户的消息；系统事件和企业微信坐席消息不会被误提交打印。每个客户消息只发送一条最终回执，客服回执失败仅记录错误，不会造成网关进程退出。

## 企业微信侧配置

1. 在企业微信管理后台开通「微信客服」，创建客服帐号并取得其 `open_kfid`。
2. 在「微信客服应用」开启 API，授权该客服帐号由 API 管理，记录 CorpID、微信客服 Secret。
3. 配置回调 URL：`https://你的域名/wecom/kf/callback`；回调服务实际监听端口默认为 `3000`。记录 Token 与 EncodingAESKey。
4. 反向代理必须将该路径转发到宿主机 `127.0.0.1:3000`；企业微信需要能通过公网 HTTPS 访问它。
5. 用户先向客服发一条消息，从网关的 `wecom_kf_ignored_sender` 日志取得其 `external_userid`，填入白名单后重启服务。

## 部署

在上游 cups-web 中创建普通用户并确认 CUPS 队列 URI。复制配置模板后填写实际值：

```bash
cp .env.example .env
# 编辑 .env，填写企业微信、CUPS 与 cups-web 配置
docker compose up -d
```

`.env` 默认不会提交到 Git。推荐为每个个人微信用户创建独立 cups-web 用户，并在 `.env` 设置 `WECOM_CUPS_USER_CREDENTIALS`（JSON）：这样 cups-web 历史与客服“打印记录”都会按用户隔离。映射必须覆盖白名单中的每个用户：

```dotenv
WECOM_ALLOWED_EXTERNAL_USERS=wmAlice,wmBob
WECOM_CUPS_USER_CREDENTIALS='{"wmAlice":{"username":"alice","password":"alice 的 cups-web 密码"},"wmBob":{"username":"bob","password":"bob 的 cups-web 密码"}}'
```

网关会按该映射使用独立登录会话提交任务，因此支持用户隔离的 cups-web 可直接按登录用户显示各自历史记录；网关内置的“打印记录”查询也仍会按个人微信用户隔离。

旧版共享账号 `CUPS_WEB_USER` / `CUPS_WEB_PASSWORD` 仅用于兼容已有部署；不设置 `WECOM_CUPS_USER_CREDENTIALS` 时才会启用，所有用户会共享同一份 cups-web 历史。

网关使用 host 网络，通过 `127.0.0.1:1180` 访问独立运行的 cups-web；如需其他地址，设置 `CUPS_WEB_URL`。SQLite 数据保存到项目的 `./data`。

若客服提示“登录后未返回 CSRF Token”，通常是 `CUPS_WEB_URL` 使用的协议与 cups-web 的 Cookie 配置不一致：网关通过 HTTP 访问时，cups-web 不应强制 `COOKIE_SECURE=true`；通过 HTTPS 反向代理访问时，应把 `CUPS_WEB_URL` 配为对应的 HTTPS 地址，并确保反向代理正确传递 `X-Forwarded-Proto: https`。

## 打印确认与回执

- 用户发送文字、图片或文件后，网关先发送确认菜单；只有点击“确认打印 N 个内容”后才会下载文件并提交 CUPS。多个内容全部提交成功时，会合并为一条“已提交 CUPS 打印任务 7（1 页）、8（1 页）”回执，避免重复说明。
- 提交后立即回复 CUPS 任务编号，随后直接查询 CUPS 的 IPP `job-state`；同一轮查询中完成的多个任务会合并为一条“CUPS 已完成打印任务 7、8”回执并附“打印记录”按钮，节省客服回复额度。该状态以 CUPS 为准，仍应以实际出纸为准。
- 每次收到新的打印内容，网关都会发送一条更新后的确认菜单，列出当前批次所有待打印内容；旧菜单自动失效，必须点击最新菜单。确认菜单默认 10 分钟有效，超时后自动失效。CUPS 状态每 5 秒查询一次，最多查询 10 分钟。可按需设置：`PRINT_CONFIRMATION_TTL_MS`、`PRINT_STATUS_POLL_MS`、`PRINT_STATUS_TIMEOUT_MS`。

  ```text
  如需打印更多，继续发送打印内容
  已收到打印内容，请确认是否打印：

  1. 333.txt
  2. 000.txt

  确认打印 2 个内容
  取消
  ```
- 纯文本会以内容开头的前 10 个字符生成 `.txt` 文件名，便于在 cups-web 历史中识别；无法生成合法名称时回退为 `message.txt`。
- 用户发送“打印记录”，或点击任意打印任务回执中的“打印记录”按钮，网关会以该个人微信用户映射的 cups-web 身份查询 `/api/print-records`，返回 cups-web 最近 5 条记录；每条展示文件名、状态、任务号、页数和提交时间。cups-web 的 `printed` 仅表示已向 CUPS 提交，实际出纸仍以 CUPS 完成回执为准。
- 企业微信 API 单次请求默认 60 秒超时；网络超时、`408`、`429`、`5xx` 和可恢复错误码会按指数退避重试 2 次（首次请求共 3 次）。可使用 `WECOM_API_REQUEST_TIMEOUT_MS`、`WECOM_API_MAX_RETRIES`（`0`–`5`）和 `WECOM_API_RETRY_BASE_MS` 调整。回复使用稳定 `msgid`，重试不会重复发送。

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
