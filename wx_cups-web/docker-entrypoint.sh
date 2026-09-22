#!/bin/sh
set -eu

# `./data` 是宿主机绑定目录，Docker 首次创建时常为 root 所有。
mkdir -p /app/data
chown -R 10001:10001 /app/data
exec su-exec 10001:10001 "$@"
