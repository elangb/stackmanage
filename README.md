<div align="center">
  <img src="./build/icon.png" width="120" alt="StackManage icon" />

  <h1>StackManage</h1>

  <p><strong>Run your local development stack natively.</strong></p>

  <p>
    StackManage is an independent desktop workspace for installing and running
    web servers, runtimes, databases and local sites on your own machine.
    No container is required for the core workflow.
  </p>

  <p>
    <img alt="Version 0.1.0" src="https://img.shields.io/badge/version-0.1.0-0f766e" />
    <img alt="Verified on Linux x64" src="https://img.shields.io/badge/platform-Linux%20x64-0f766e" />
    <img alt="Telemetry off" src="https://img.shields.io/badge/telemetry-off-0f766e" />
    <img alt="BSD 3-Clause License" src="https://img.shields.io/badge/license-BSD--3--Clause-blue" />
  </p>

  <p>
    <a href="#install">Install</a> ·
    <a href="#what-you-can-run">Features</a> ·
    <a href="#mcp-server">MCP</a> ·
    <a href="#build-from-source">Build from source</a> ·
    <a href="#documentation">Documentation</a>
  </p>
</div>

---

## Why StackManage?

- **Native by default.** Install vendor binaries into your user profile and run
  them directly. You do not need Docker, a VM or a background cloud account for
  everyday local development.
- **Pinned and verified downloads.** Each module resolves an official artifact,
  checks its SHA-256 digest and validates the result before it is used.
- **One workspace for the local stack.** Manage services, local domains and
  HTTPS beside the runtimes and databases that power them.
- **Loopback-first.** Managed sites and services bind to `127.0.0.1` by default
  and are not exposed to your network.
- **No telemetry and no licence gate.** StackManage has no usage reporting,
  activation key or artificial module/site/project limits.
- **Honest about limits.** Areas that are not implemented are labelled as
  unavailable instead of being simulated.

## What you can run

| Module | Pinned release | What StackManage can do today | Support |
|---|---|---|---|
| **Caddy** | 2.11.8 | Install from the official release, verify the checksum, start/stop/restart, serve HTTP and HTTPS sites on loopback, manage a marked hosts block for `.test` domains, trust the local CA in browser stores, show bounded logs | Linux x64 verified |
| **Node.js** | 24.22.2 | Install the official runtime per user, verify SHA-256, run `node --version`, expose the binary path and a PATH-prepend plan, uninstall | Linux x64 verified |
| **Nginx** | 1.30.6 | Build from official source into a per-user prefix, validate with `nginx -t`, serve on `127.0.0.1:18081`, reload, stop and uninstall | Linux x64 verified |
| **Redis** | 7.2.7 | Build from official source, run on `127.0.0.1:16379` with protected mode and a 64 MiB cap, check `PING`/`PONG`, use `SET`/`GET`, stop and uninstall | Linux x64 verified |
| **MCP server** | 1.32.2 SDK | Expose seven read-only tools over stdio for inspection of the local workspace | Linux x64 tested |
| **Plugin host** | 1.0.0 SDK | Install, verify, enable, disable and remove signed local plugin packages with an isolated child process | Linux x64 tested |
| **PHP build runner** | 8.5.12 | Reproducibly build and verify a Linux x64 PHP runtime tarball on a Docker/Podman-capable host | Build tooling only |

The desktop app currently includes **Overview**, **Languages & Runtime**,
**Web Servers & Sites**, **Databases** and **Settings**. Cache/messaging,
infrastructure, workflow automation, AI clients and the plugin marketplace are
shown as unavailable until their implementations and evidence land.

> **Platform note:** Linux x64 is the only platform with end-to-end execution
> evidence in this release. Linux arm64 uses the same pins but has not been
> executed. Windows and macOS are not supported yet. See the
> [support matrix](docs/feature-matrix.md) for the precise state of each feature.

## Install

### Linux x64 package

Download the latest `.deb` from
[GitHub Releases](https://github.com/elangb/stackmanage/releases), then install it:

```sh
sudo apt install ./StackManage-0.1.0-amd64.deb
```

The package is also produced locally by the build command below. If a release
artifact is not available for your machine, use **Build from source**.

### Requirements

- Linux x64 with a desktop session and Electron system libraries.
- Node.js **24.x** and pnpm **10.32.1** for source builds.
- A C compiler, `make`, PCRE2, zlib and OpenSSL development headers to build
  Nginx from source.
- A C compiler and `make` to build Redis from source.
- No root access is required to install modules. Editing the system hosts file
  may request elevation through the platform helper.

## Build from source

```sh
git clone https://github.com/elangb/stackmanage.git
cd stackmanage
pnpm install --frozen-lockfile
pnpm dev
```

Build and package:

```sh
pnpm build
pnpm dist:linux:deb:x64
pnpm dist:linux:deb:arm64
```

Artifacts are written to `release/`. Packaging details and current limits are in
[docs/packaging.md](docs/packaging.md).

## MCP server

StackManage ships a real stdio MCP server for **read-only** inspection. It opens
no TCP port and has no install, start, stop or write tool.

| Tool | Purpose |
|---|---|
| `system.info` | Host and runtime information |
| `modules.list` | Supported module catalog |
| `installations.list` | Recorded installations |
| `services.status` | Service identity and readiness |
| `sites.list` | Managed local sites |
| `logs.tail` | Bounded log tail with redaction |
| `config.read` | Bounded configuration read with redaction |

Build it first, then register the absolute path in your MCP client:

```sh
pnpm --filter @stackmanage/mcp-server build
```

```json
{
  "mcpServers": {
    "stackmanage": {
      "command": "node",
      "args": ["/absolute/path/to/stackmanage/packages/mcp-server/dist/index.js"]
    }
  }
}
```

See [docs/mcp.md](docs/mcp.md) for the data layout, redaction rules and security
model. Mutations are intentionally out of scope until an authenticated and
user-approved bridge exists.

## Plugins

The local plugin host verifies Ed25519-signed packages, pins package and
manifest digests, installs into a managed directory and runs one child process
per enabled plugin. It is a backend capability: the marketplace UI is not part
of this release. The child process is **not** an OS sandbox; see
[docs/plugin-sdk.md](docs/plugin-sdk.md) for the capability model and limits.

## PHP runtime builder

The PHP builder produces a verified `tar.gz`, SHA-256 and manifest without
requiring host root. It needs Docker or Podman:

```sh
./scripts/php/build-php-runtime.sh --output-dir release/php
./scripts/php/build-php-runtime.sh --verify-only --output-dir release/php
```

The desktop PHP module, PHP-FPM site integration and a PHP runtime installer are
not included in this release. Build details are in
[docs/php-build-runner.md](docs/php-build-runner.md).

## Release verification

Every release candidate must pass the full local gate:

```sh
pnpm check          # typecheck, lint, build, unit/integration tests, legal inventory
xvfb-run -a pnpm test:desktop
```

Real-network module tests are opt-in because they download pinned upstream
artifacts:

```sh
STACKMANAGE_INTEGRATION=1 pnpm exec vitest run apps/worker/test/caddy.integration.test.ts
STACKMANAGE_INTEGRATION=1 pnpm exec vitest run apps/worker/test/node.integration.test.ts
STACKMANAGE_INTEGRATION=1 pnpm exec vitest run apps/worker/test/nginx.integration.test.ts
STACKMANAGE_INTEGRATION=1 pnpm exec vitest run apps/worker/test/redis.integration.test.ts
```

## Project layout

| Path | Responsibility |
|---|---|
| `apps/desktop` | Electron main process, sandboxed preload, Vue renderer and module controllers |
| `apps/worker` | Forked worker that owns module installation, processes and PID state |
| `packages/core` | Versioned IPC and operation contracts |
| `packages/platform` | OS adapter boundary for hosts, trust, autostart and shell plans |
| `packages/modules` | Module catalog declarations |
| `packages/mcp-server` | Read-only stdio MCP server |
| `packages/plugin-sdk` | Plugin manifest and JSON-RPC schemas |
| `packages/plugin-host` | Signed package installer, registry verification and plugin runtime |
| `packages/i18n`, `packages/ui` | Five locales and original design tokens |
| `build`, `ci`, `scripts` | Runtime builders, CI templates and verification scripts |

## Documentation

- [Feature and evidence matrix](docs/feature-matrix.md)
- [Architecture decision records](docs/adr/0001-foundation.md)
- [Contracts](docs/contracts-v1.md)
- [Platform adapters](docs/platform-adapters.md)
- [MCP server](docs/mcp.md)
- [Plugin SDK](docs/plugin-sdk.md)
- [PHP build runner](docs/php-build-runner.md)
- [Packaging](docs/packaging.md)
- [Legal analysis](docs/legal/license-analysis.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Security

- The Electron renderer runs sandboxed with context isolation and a narrow,
  typed preload bridge.
- Services bind to loopback by default; StackManage does not add firewall rules
  or expose them publicly.
- Downloads use pinned HTTPS sources, allowlists, size limits, checksum checks
  and, where available, detached signatures.
- The local CA is trusted only in the current user's browser stores. System-wide
  trust is a separate, explicit elevation path.
- Secrets in logs and configuration are redacted before they leave the MCP
  server.

## Contributing

Issues and pull requests are welcome. Before opening a pull request, run
`pnpm check` and `xvfb-run -a pnpm test:desktop`, and keep documentation aligned
with the actual execution evidence.

## License

StackManage is released under the [BSD 3-Clause License](LICENSE). Third-party
components and downloaded vendor runtimes keep their own licences; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
