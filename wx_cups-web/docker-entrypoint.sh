#!/bin/sh
set -eu

# `./data` 是宿主机绑定目录，Docker 首次创建时常为 root 所有。
# 启动阶段仅调整该目录，然后降权为 node 用户运行网关。
mkdir -p /app/data
chown -R node:node /app/data

exec gosu node "$@"
