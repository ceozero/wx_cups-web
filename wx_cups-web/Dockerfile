FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -buildvcs=false -trimpath -ldflags="-s -w" -o /out/wx-cups-web .

FROM alpine:3.22
WORKDIR /app
# 仅保留静态 Go 二进制、根证书与挂载目录降权工具。
RUN apk add --no-cache ca-certificates su-exec
COPY --from=build /out/wx-cups-web /usr/local/bin/wx-cups-web
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint
RUN mkdir -p /app/data && chmod 755 /usr/local/bin/wx-cups-web /usr/local/bin/docker-entrypoint
ENTRYPOINT ["docker-entrypoint"]
CMD ["wx-cups-web"]
