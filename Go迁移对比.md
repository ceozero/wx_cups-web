# TypeScript 到 Go 迁移对比

`main` 与 `typescript` 分支保留原有 TypeScript 实现；`go` 分支改为纯 Go 服务，运行入口保持不变：
`/wecom/kf/callback`、`.env`、Compose 服务名、数据卷路径和企业微信/cups-web 协议均无需变更。

| 能力 | TypeScript 基线 | Go 实现 |
| --- | --- | --- |
| 企业微信回调 | SHA-1 验签、AES-256-CBC 解密、CorpID 校验 | 同等实现，并有加解密回归测试 |
| 企业微信 API | access_token 缓存、重试、稳定 `msgid`、媒体下载 | 同等实现 |
| 打印提交 | 每位微信用户的 `cw_` API Key、固定打印参数 | 同等 Bearer 认证与 multipart 字段 |
| 防重与确认 | SQLite 消息去重、确认批次、旧菜单失效 | 同等 SQLite 模型与事务批次处理 |
| CUPS 最终回执 | IPP `Get-Job-Attributes` 轮询 | 同等二进制 IPP 请求和状态解析 |
| 镜像运行时 | Node 22 + 生产依赖 | Go 静态二进制 + Alpine 根证书/降权工具 |

## 已完成校验

在 `wx_cups-web` 目录执行：

```powershell
go test ./...
go vet ./...
$env:CGO_ENABLED = '0'
$env:GOOS = 'linux'
$env:GOARCH = 'amd64'
go build -buildvcs=false -trimpath -ldflags='-s -w' .
```

- Go 单元测试覆盖配置/API Key 映射、回调签名和 AES 解密、文件头校验、SQLite 确认批次、企业微信 JSON 字段映射、IPP 请求和状态解析。
- 已完成 `linux/amd64`、`CGO_ENABLED=0` 构建；本地二进制为约 10 MB。
- 尚未对真实企业微信、cups-web 和 CUPS 发送请求；这需要部署环境的真实凭据与打印队列，不能以静态测试替代。
