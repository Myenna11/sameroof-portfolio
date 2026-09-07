#!/bin/sh
# 签客厅 ↔ 网关的 service token：同一个随机串写两处——网关读 /var/lib/sameroof-gateway/living-room.token（sameroof-gateway 0600），
# 客厅读 ~/.sameroof/run/gateway-service.token（客厅进程用户 0600，客厅每次请求现读，不用重启）。token 不回显、不进日志。
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "请以 root 运行。" >&2
  exit 1
fi
lr_home=${SAMEROOF_LIVING_ROOM_HOME:-/root}
gw_file=/var/lib/sameroof-gateway/living-room.token
lr_file=$lr_home/.sameroof/run/gateway-service.token

if [ -s "$gw_file" ] && [ "${1:-}" != "--rotate" ]; then
  echo "$gw_file 已经有 token；要换就加 --rotate。" >&2
  exit 1
fi
token=$(node -e 'process.stdout.write("srv_" + require("crypto").randomBytes(32).toString("base64url"))')

install -d -o sameroof-gateway -g sameroof -m 0700 /var/lib/sameroof-gateway
umask 077
printf '%s\n' "$token" > "$gw_file.tmp" && chown sameroof-gateway:sameroof "$gw_file.tmp" && chmod 0600 "$gw_file.tmp" && mv -f "$gw_file.tmp" "$gw_file"
install -d -m 0700 "$(dirname "$lr_file")"
printf '%s\n' "$token" > "$lr_file.tmp" && chmod 0600 "$lr_file.tmp" && mv -f "$lr_file.tmp" "$lr_file"
echo "service token 已写入 $gw_file 和 $lr_file（各 0600）。"
