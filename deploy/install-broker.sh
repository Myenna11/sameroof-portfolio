#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "请以 root 运行。" >&2
  exit 1
fi

repo=${1:-/root/sameroof}
src=$repo/packages/broker
test -f "$src/package-lock.json"
test -f "$repo/deploy/sameroof-broker.service"

getent group sameroof >/dev/null || groupadd --system sameroof
if ! getent passwd sameroof-broker >/dev/null; then
  useradd --system --no-create-home --home-dir /var/lib/sameroof-broker --shell /usr/sbin/nologin --gid sameroof sameroof-broker
fi

install -d -o root -g root -m 0755 /opt/sameroof/broker
install -o root -g root -m 0644 "$src/package.json" "$src/package-lock.json" "$src/server.js" "$src/store.js" /opt/sameroof/broker/
install -o root -g root -m 0755 "$src/brokerctl.js" /opt/sameroof/broker/brokerctl.js
cd /opt/sameroof/broker
npm ci --omit=dev --no-audit --no-fund
chown -R root:root /opt/sameroof/broker

install -o root -g root -m 0644 "$repo/deploy/sameroof-broker.service" /etc/systemd/system/sameroof-broker.service
install -o root -g root -m 0755 "$repo/deploy/sameroof-broker" /usr/local/bin/sameroof-broker
systemctl daemon-reload
echo "broker 程序与 unit 已安装；迁移现有状态后再启动服务。"
