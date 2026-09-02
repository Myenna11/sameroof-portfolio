#!/bin/sh
set -eu
if [ "$(id -u)" -ne 0 ]; then
  echo "请以 root 运行。" >&2
  exit 1
fi
repo=${1:-/root/sameroof}
test -x "$repo/packages/cli/index.js"
ln -sfn "$repo/packages/cli/index.js" /usr/local/bin/sameroof
echo "已安装 /usr/local/bin/sameroof -> $repo/packages/cli/index.js"
