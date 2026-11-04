# StackManage — Phase 3

An original, independent desktop workspace for local development. Product policy: **unlimited licensing, telemetry off**. These settings do not make claims about third-party software licences.

## What works now

On **Linux x64 only**, StackManage can install Caddy 2.11.8 from the official upstream release, verify its checksums, start/stop/restart it, serve managed HTTP/HTTPS sites on loopback, update a marked hosts block for `.test` domains, trust its local CA in user NSS stores, show bounded logs, and reconcile a stale process after an ungraceful worker restart. It can also install the pinned official Node.js 24.22.2 runtime into the per-user data directory, verify its SHA-256, run `node --version`, expose the binary path and a PATH-prepend plan, and uninstall it. Browser-level certificate acceptance, system trust, Windows and Linux arm64 execution are **not yet verified**. Node.js Windows/arm64 artifacts are pinned but unexecuted; shell hooks, project environments and version switching are not implemented yet. Nginx, databases, other runtimes, MCP transport, plugins and installers are not implemented yet.

The UI labels unimplemented areas as unavailable; no feature is simulated.

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

Real-network integration evidence (downloads the pinned Caddy release and the official Node.js archive):

```sh
STACKMANAGE_INTEGRATION=1 pnpm exec vitest run apps/worker/test/caddy.integration.test.ts
STACKMANAGE_INTEGRATION=1 pnpm exec vitest run apps/worker/test/node.integration.test.ts
```

`pnpm dev` uses Vite HMR for the renderer; changes to main/preload/worker require restarting. Vite binds only `127.0.0.1:5179`. Do not disable the Electron sandbox to make tests pass. On headless Linux use a provisioned display such as `xvfb-run -a pnpm test:desktop`.

## Layout

| Path | Responsibility |
|---|---|
| `apps/desktop` | Main process, sandboxed preload, Vue renderer, module-local controllers |
| `apps/worker` | Fork worker; owns Caddy install/process/PID/sites and the pinned Node.js runtime installer |
| `packages/core` | Frozen v1 contracts plus additive Phase 1 bridge/operation schemas |
| `packages/platform` | OS adapter boundary (hosts/trust/autostart/shell plans; platform tests) |
| `packages/modules` | Catalog declarations; runtime implementation lives in the worker module |
| `packages/mcp-server` | Deny-by-default placeholder; no transport yet |
| `packages/plugin-sdk` | Manifest/API exports; no plugin execution |
| `packages/i18n`, `packages/ui` | Five locales and original design tokens |
| `docs`, `ci` | ADRs, evidence matrix, legal inventory, workflow templates |

Read [ADR 0001](docs/adr/0001-foundation.md), [ADR 0002](docs/adr/0002-phase1-vertical-slice.md), [ADR 0003](docs/adr/0003-hosts-tls-trust.md), [contracts](docs/contracts-v1.md), [feature matrix](docs/feature-matrix.md), [legal analysis](docs/legal/license-analysis.md), [third-party notices](THIRD_PARTY_NOTICES.md), and the [Phase 1](docs/reports/phase1-core.md) / [hosts+TLS](docs/reports/phase2-hosts-tls.md) reports.
