# 同屋 · Same Roof Web

A standalone, responsive front door for the existing house. No build step or new
runtime dependency. It does not replace `apps/house` or restart resident adapters.

## Run and check

```sh
node apps/roof/server.cjs
node --test apps/roof/server.test.cjs
```

Defaults: bind `127.0.0.1:17930`, proxy `http://127.0.0.1:8790`, read records from
`/root/sameroof`. Override with `PORT`, `ROOF_UPSTREAM`, `SAMEROOF_ROOT`.
Open the trailing-slash URL. All browser assets and API requests are relative,
so deployment at `/sameroof/` is supported.

## Experience and data boundary

- Public visitors see explicitly labelled demonstration data. Demo changes are
  in-memory only and never sent to the house. Reload resets them.
- Connect with an existing **human resident** bearer token. It stays in the tab's
  session storage, never in a URL. Disconnect clears it. The existing living-room
  service remains authoritative for messages, tasks, approvals and room access.
- Living room, private conversations, task creation/status/notes, one-shot
  approvals, quota information and read-only memories use existing APIs.
- Event stream refreshes the UI, with a polling fallback. Work records refresh
  every eight seconds while visible. This is observation, not terminal control.
- No telemetry, CDN, remote font, service worker, third-party avatar or analytics.

## Workbench: honest sources, not a fabricated terminal

The workbench exposes recorded session events, their JSON representation,
resident service logs, and subagent records. It does **not** claim to be a PTY
mirror or expose hidden model reasoning. Only reasoning summaries actually
present in recorded output can be shown. Existing adapters do not persist every
tool's full stdout, so an absent record remains absent.

Limits are displayed in the UI: current shift file, last 512 KiB per record,
latest 30 subrun files, last 1,000 service journal lines. Partial data is labelled.
Session system messages are excluded. Common credential patterns and sensitive
JSON keys are redacted; this is defense in depth, not a guarantee that arbitrary
private text is safe to share. Only authenticated human residents can read these
views. Download exports the displayed, scoped records, not an entire filesystem.

`GET /api/work` authenticates against `/me` on every request, resolves residents
from `/members`, restricts file realpaths and journal unit names, and has no shell
input or write operation. API proxy routes are allowlisted; internal/admin routes
are not exposed. The service binds loopback and sends no-store/CSP headers.

## Deploy without disturbing the house

Use `deploy/sameroof-web.service` and `deploy/sameroof-web.nginx.conf`.
Create an unprivileged `sameroof-web` system user. Place this directory under a
versioned `/opt/sameroof-web/releases/<commit>/` and point `current` at it.
The service uses the journal group for resident service logs, and read-only access
to the existing record files. Do not make private records world-readable to
solve permissions errors: unavailable sources should stay unavailable.

Back up the active example-site nginx configuration, include the route snippet **inside
the example-site server block**, run `nginx -t`, then reload nginx. This preserves `/`
and `/kitchen/`. Start only `sameroof-web.service`; do not restart living-room,
broker, gateway or residents. Roll back by restoring the nginx backup and the
previous `current` symlink. No database migration or token rotation is needed.

Before release: run the authorization tests, check unauthenticated requests return
401, verify existing token access without publishing it, inspect desktop/mobile
rendering, and confirm existing example-site routes still respond.
