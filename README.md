# StackManage — Phase 8

An original, independent desktop workspace for local development. Product policy: **unlimited licensing, telemetry off**. These settings do not make claims about third-party software licences.

## What works now

On **Linux x64 only**, StackManage can install Caddy 2.11.8 from the official upstream release, verify its checksums, start/stop/restart it, serve managed HTTP/HTTPS sites on loopback, update a marked hosts block for `.test` domains, trust its local CA in user NSS stores, show bounded logs, and reconcile a stale process after an ungraceful worker restart. It can also install the pinned official Node.js 24.22.2 runtime into the per-user data directory, verify its SHA-256, run `node --version`, expose the binary path and a PATH-prepend plan, and uninstall it. Nginx stable 1.30.6 can be built from the official source into a per-user prefix, served on `127.0.0.1:18081`, reloaded with `nginx -t` validation, stopped and uninstalled; the build requires a C compiler, make, PCRE2, zlib and OpenSSL development headers. Redis 7.2.7 (BSD-3-Clause) can be built from the official source into a per-user prefix, started on `127.0.0.1:16379` with protected mode and a 64 MiB cap, checked through `redis-cli ping` = `PONG`, used for SET/GET, stopped, and uninstalled; the build requires a C compiler and make. Google Chrome certificate acceptance is verified on Linux x64; Firefox, Edge, system trust, Windows and Linux arm64 execution are **not yet verified**. Nginx Linux arm64 uses the same source pin but is unexecuted; the official Windows zip is pinned but Windows execution is **unsupported** in this build. Redis Linux arm64 uses the same source pin but is unexecuted; Redis Windows is **unsupported** because upstream publishes no supported native build and no unofficial fork is used. Node.js Windows/arm64 artifacts are pinned but unexecuted; shell hooks, project environments and version switching are not implemented yet. Nginx PHP-FPM integration, other databases, other runtimes, A stdio MCP server exposes seven read-only tools for system, module, installation, service, site, log and config inspection; it binds no port and exposes no mutation. MCP mutations and plugin market UI/worker bridge are not implemented; a local PluginHost backend can verify/install signed Ed25519 packages and run enabled plugins in isolated child processes, but a Node child is not an OS sandbox. Redis authentication/ACL, replication, cluster, TLS and persistence tuning are not implemented.

The UI labels unimplemented areas as unavailable; no feature is simulated. A reproducible PHP 8.5.12 Linux x64 build runner can produce a verified tar.gz, SHA-256 and manifest under `release/php/` on a Docker/Podman-capable host; the PHP worker module and UI are not implemented yet, and the authoring environment did not execute a container build. See [PHP build runner](docs/php-build-runner.md).

## Run

Prerequisites: Node **24.x**, pnpm **10.32.1**, a desktop session and Electron system libraries.

```sh
cd stackmanage
pnpm install --frozen-lockfile
pnpm dev
```

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm legal:verify
pnpm build
pnpm test:desktop
```

Real-network integration evidence (downloads pinned Caddy, Node.js and Nginx artifacts):

```sh
STACKMANAGE_INTEGRATION=1 pnpm exec vitest run apps/worker/test/caddy.integration.test.ts
STACKMANAGE_INTEGRATION=1 pnpm exec vitest run apps/worker/test/node.integration.test.ts
STACKMANAGE_INTEGRATION=1 pnpm exec vitest run apps/worker/test/nginx.integration.test.ts
STACKMANAGE_INTEGRATION=1 pnpm exec vitest run apps/worker/test/redis.integration.test.ts
```

The PHP build runner needs Docker or Podman and no host root:

```sh
./scripts/php/build-php-runtime.sh --output-dir release/php
./scripts/php/build-php-runtime.sh --verify-only --output-dir release/php
```

`pnpm dev` uses Vite HMR for the renderer; changes to main/preload/worker require restarting. Vite binds only `127.0.0.1:5179`. Do not disable the Electron sandbox to make tests pass. On headless Linux use a provisioned display such as `xvfb-run -a pnpm test:desktop`.

## Layout

| Path | Responsibility |
|---|---|
| `apps/desktop` | Main process, sandboxed preload, Vue renderer, module-local controllers |
| `apps/worker` | Fork worker; owns Caddy, Nginx and Redis install/process/PID state plus the pinned Node.js runtime installer |
| `packages/core` | Frozen v1 contracts plus additive Phase 1 bridge/operation schemas |
| `packages/platform` | OS adapter boundary (hosts/trust/autostart/shell plans; platform tests) |
| `packages/modules` | Catalog declarations; runtime implementation lives in the worker module |
| `packages/mcp-server` | Stdio MCP server; seven read-only tools, no listener and no mutations |
| `packages/plugin-sdk` | Additive plugin manifest/JSON-RPC schemas; no host runtime |
| `packages/plugin-host` | Local signed-package installer, registry verification and child-process plugin runtime; no market UI or bridge |
| `packages/i18n`, `packages/ui` | Five locales and original design tokens |
| `docs`, `ci` | ADRs, evidence matrix, legal inventory, workflow templates |

Packaging: see [Linux deb packaging](docs/packaging.md). PHP runtime builder: [PHP build runner](docs/php-build-runner.md). Read [ADR 0001](docs/adr/0001-foundation.md), [ADR 0002](docs/adr/0002-phase1-vertical-slice.md), [ADR 0003](docs/adr/0003-hosts-tls-trust.md), [contracts](docs/contracts-v1.md), [feature matrix](docs/feature-matrix.md), [legal analysis](docs/legal/license-analysis.md), [third-party notices](THIRD_PARTY_NOTICES.md), and the [Phase 1](docs/reports/phase1-core.md) / [hosts+TLS](docs/reports/phase2-hosts-tls.md) / [Node runtime](docs/reports/phase3-node-runtime.md) / [Nginx](docs/reports/phase4-nginx.md) / [Redis](docs/reports/phase6-redis.md) / [MCP](docs/reports/phase7-mcp-readonly.md) / [PHP build runner](docs/reports/phase8-php-runner.md) / [plugin runtime](docs/reports/phase9-plugin-runtime.md) reports. Plugin backend details: [Plugin SDK](docs/plugin-sdk.md).
