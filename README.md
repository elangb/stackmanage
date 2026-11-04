# StackManage — Phase 0

An original, independent desktop foundation for a local development workspace. Product policy: **unlimited licensing, telemetry off**. These product settings do not make claims about third-party software licenses. Legal review belongs to the later legal agent.

## Run

Prerequisites: Node **24.x**, pnpm **10.32.1**, a normal desktop session and Electron system libraries. Install pnpm using your preferred package-manager setup. This nested workspace is independent of the legacy root Yarn project.

```sh
cd stackmanage
pnpm install --frozen-lockfile
pnpm dev
```

The Vue renderer has Vite HMR. Changes to main/preload/worker require restarting `pnpm dev`. Vite binds only `127.0.0.1:5179`; an occupied port fails explicitly. Do not disable the Electron sandbox to make tests pass.

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:desktop
pnpm legal:verify
```

`build` produces executable Electron bundles in `apps/desktop/dist` and the standalone fork bundle in `apps/worker/dist`. To run the built app: `pnpm --filter @stackmanage/desktop exec electron .`. This is not an installer/packager. On headless Linux use an already-provisioned display such as `xvfb-run -a pnpm test:desktop`. Windows and Linux acceptance requires genuine runs, not cross-build claims.

## What exists

- Electron + Vue 3 shell, five locales (Indonesian, English, Simplified Chinese, Spanish, Vietnamese).
- Sandboxed preload with one typed, validated `snapshot()` method; no generic IPC, filesystem, shell or arbitrary URL bridge.
- Fork worker health RPC with correlation, bounds, deadlines and shutdown ownership.
- Strict TypeScript and frozen v1 schemas/interfaces, meaningful schema/IPC/controller/fork tests.
- Skeletal platform, module catalog, MCP server and plugin SDK. The module registry and exposed MCP tools are empty intentionally.

Runtime installation, services, sites, automation, plugins, privileges and packaging are not implemented. The shell explicitly says so.

## Layout and handoff

| Path | Responsibility |
|---|---|
| `apps/desktop` | Main, sandbox preload, Vue view and bootstrap controller |
| `apps/worker` | Fork worker and main-side RPC owner |
| `packages/core/src/v1` | Frozen contracts; module-agnostic schemas |
| `packages/platform` | Platform adapter boundary, implementation pending |
| `packages/modules` | Original module adapters, currently empty |
| `packages/mcp-server` | Deny-by-default placeholder, no transport |
| `packages/plugin-sdk` | Manifest/API exports, no plugin execution |
| `packages/i18n`, `packages/ui` | Local messages, reactive binding and original CSS |
| `docs`, `ci` | ADRs, scope/evidence, workflow template and checks |

Start with [architecture decisions](docs/adr/0001-foundation.md), [operation plan](docs/operation-plan.md), [v1 contract guide](docs/contracts-v1.md), [feature matrix](docs/feature-matrix.md), [legal analysis](docs/legal/license-analysis.md), [third-party notices](THIRD_PARTY_NOTICES.md), and the Phase 0 [architecture](docs/reports/phase0.md) / [legal](docs/reports/phase0-legal.md) evidence reports.
