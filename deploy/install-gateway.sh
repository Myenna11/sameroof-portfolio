#!/bin/sh
# 安装能力网关：专用用户、/opt 只读程序、systemd unit、控制面命令。不启动服务；service token 用 gateway-service-token.sh 另签。
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "请以 root 运行。" >&2
  exit 1
fi

repo=$(realpath "${1:-/root/sameroof}")
# Unit path fields and the sed replacement below only support simple absolute paths.
case "$repo" in *[!a-zA-Z0-9_./-]*) echo 'Repository path must not contain whitespace or shell/unit metacharacters.' >&2; exit 1 ;; esac
src=$repo/packages/gateway
test -f "$src/server.js"
test -f "$repo/deploy/sameroof-gateway.service"

getent group sameroof >/dev/null || groupadd --system sameroof
if ! getent passwd sameroof-gateway >/dev/null; then
  useradd --system --no-create-home --home-dir /var/lib/sameroof-gateway --shell /usr/sbin/nologin --gid sameroof sameroof-gateway
fi

install -d -o root -g root -m 0755 /opt/sameroof/gateway
install -o root -g root -m 0644 "$src/server.js" /opt/sameroof/gateway/
install -o root -g root -m 0755 "$src/gatewayctl.js" /opt/sameroof/gateway/gatewayctl.js
# 公共依赖走 npm；@sameroof/* 是仓库里的 workspace 包，注册表上没有，直接拷进 node_modules
node -e '
  const p = require(process.argv[1]); const keep = {};
  for (const [k, v] of Object.entries(p.dependencies || {})) if (!k.startsWith("@sameroof/")) keep[k] = v;
  require("fs").writeFileSync("/opt/sameroof/gateway/package.json", JSON.stringify({ name: p.name, version: p.version, private: true, main: "server.js", dependencies: keep }, null, 2) + "\n");
' "$src/package.json"
cd /opt/sameroof/gateway
npm install --omit=dev --no-audit --no-fund --no-package-lock
install -d -m 0755 node_modules/@sameroof
for pkg in jcs schema; do
  rm -rf "node_modules/@sameroof/$pkg"
  cp -a "$repo/packages/$pkg" "node_modules/@sameroof/$pkg"
  rm -rf "node_modules/@sameroof/$pkg/test"
done
chown -R root:root /opt/sameroof/gateway

# 服务的 state 目录（StateDirectory= 也会建，先建好是为了 service token 能在首次启动前写进去）
install -d -o sameroof-gateway -g sameroof -m 0700 /var/lib/sameroof-gateway
# unit 里把 /root/sameroof 绑到 /srv/sameroof；挂载点先在宿主上占好位
install -d -o root -g root -m 0755 /srv/sameroof

# The unit ships with the workspace at /root/sameroof; rewrite that to the repo actually being installed from.
sed "s#/root/sameroof#$repo#g" "$repo/deploy/sameroof-gateway.service" > /etc/systemd/system/sameroof-gateway.service
chmod 0644 /etc/systemd/system/sameroof-gateway.service
install -o root -g root -m 0755 "$repo/deploy/sameroof-gateway" /usr/local/bin/sameroof-gateway
systemctl daemon-reload
echo "网关程序与 unit 已安装。下一步：deploy/gateway-service-token.sh 签 service token，systemctl enable --now sameroof-gateway，再 sameroof-gateway token issue <resident_id>。"
