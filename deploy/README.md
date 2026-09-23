# deploy/ — long-running installation (systemd)

For trying Same Roof you do not need anything here: `sameroof serve --with-gateway`
runs every component under your own user (see the README). This directory is
for a machine that keeps a workspace running across reboots, with the gateway
under its own system user.

| File | What it is |
| --- | --- |
| `install-cli.sh`, `install-broker.sh`, `install-gateway.sh` | copy the program into `/opt/sameroof/<component>`, create the system user/group, install the unit |
| `gateway-service-token.sh` | writes the coordinator↔gateway service token to both sides (`/var/lib/sameroof-gateway/living-room.token`, `~/.sameroof/run/gateway-service.token`) |
| `sameroof-gateway` | wrapper for `gatewayctl.js` (`sameroof-gateway token issue <resident_id>`) |
| `sameroof-*.service` | systemd units: broker, living-room (coordinator), gateway, `sameroof-room@<resident_id>` (one adapter each), web |
| `sameroof-web.nginx.conf` | reverse-proxy snippet for the web UI |

## Assumptions baked into the units

- The workspace (the directory with `house.yaml`) lives at **`/root/sameroof`**
  and the coordinator runs as root from that source tree. `install-gateway.sh`
  rewrites the gateway unit to the repository you pass it (`install-gateway.sh
  /path/to/repo`); the other units name the path directly — change
  `WorkingDirectory=` / `SAMEROOF_ROOT=` / `BindReadOnlyPaths=` if yours differs.
- The coordinator listens on `127.0.0.1:8790`.
- `sameroof-living-room.service` reads a Codex login file from
  `/home/worker/.codex/auth.json` for the quota panel; delete that line if you
  do not have one.
- The gateway unit's hardening block is tuned so `bwrap` can still create user
  namespaces; the comments in the unit say which options must stay off and why.

## Order

```sh
sudo deploy/install-broker.sh   /path/to/repo
sudo deploy/install-gateway.sh  /path/to/repo
sudo deploy/gateway-service-token.sh
sudo systemctl enable --now sameroof-broker sameroof-living-room sameroof-gateway
sudo sameroof-gateway token issue resident_<name>_01     # once per agent
sudo systemctl enable --now sameroof-room@resident_<name>_01
```

The private deployment this edition was derived from ran this layout; its
service history is not evidence for this repository — verify on your own host.
