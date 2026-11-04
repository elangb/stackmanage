# ADR 0002: Phase 1 vertical slice and additive bridge

Status: accepted for Phase 1. Date: 2026-11-04.

## Context

Phase 0 froze v1 schemas with a health-only worker exchange and a single `snapshot()` bridge. Phase 1 must install and run a real service from the UI without inventing vendor support. Nginx has no official prebuilt Linux binary; Caddy publishes officially built Linux/Windows archives with a signed checksum list. A generic `invoke(channel, payload)` bridge would violate the deny-by-default boundary.

## Decisions

1. **First module: Caddy 2.11.8.** The worker pins the official GitHub release asset, verifies the vendor SHA-512 checksum list value and a locally computed SHA-256, extracts only the expected executable, and validates `caddy version` before committing. Linux x64 is the only combination with execution evidence; Windows and arm64 stay `unverified`.
2. **Additive bridge, not a generic RPC.** Every operation has a fixed channel name and a strict Zod request schema. The renderer receives only named methods (`install`, `start`, `stop`, `restart`, `status`, `listServices`, `listInstallations`, `logsTail`, `sitesApply`, `sitesList`, `sitesRemove`) and monotonic, bounded progress events. No channel, method, URL or filesystem path is caller-selectable beyond the typed payload.
3. **Worker owns process truth.** The fork process starts/stops Caddy, persists PID/port/config state atomically with module-scoped storage, verifies process identity before signalling, and reconciles a stale record on startup. Renderer state is never proof that a process is running.
4. **Per-user isolated data.** `STACKMANAGE_DATA_HOME` overrides the root for tests and portable mode; Electron sets it to its user-data directory. Installs, downloads, staging, sites, configs and logs remain under that module tree.
5. **Document roots are managed.** Phase 1 sites must live inside the managed sites root. This avoids turning the site form into an arbitrary filesystem write primitive. Arbitrary project roots will be added with an explicit trust/consent model later.
6. **Sites regenerate a validated Caddyfile.** The candidate file is validated with the installed binary before atomic replacement. A running service warns that a restart is required; Phase 1 does not pretend a hot reload happened.
7. **Honest limitations.** No hosts-file mutation, certificate trust, HTTPS acceptance, PHP/Node/Python, databases, MCP transport or installer artifacts are claimed in this phase. Windows code paths are compiled but unexecuted.

## Consequences

- The UI can demonstrate a real install → start → HTTP 200 → stop → uninstall-free lifecycle on Linux x64.
- Caddy is one line in the requested feature matrix, not parity. The generic worker/process/installer spine is reusable, but each additional module needs its own vendor pin, extractor policy and lifecycle tests.
- Progress events are intentionally limited to validated stage identifiers and fractions, not arbitrary text.
- A later module catalog bridge can replace the Caddy-named methods only through a versioned contract; existing v1 names stay valid.

## Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm legal:verify`.
- `STACKMANAGE_INTEGRATION=1` downloads the real official archive, verifies digests, starts Caddy, asserts HTTP 200, simulates ungraceful worker death and reconciles the orphan.
- `pnpm test:desktop` proves the sandboxed renderer → main → fork worker bridge.
- Not verification: Windows, arm64, hosts/trust changes, HTTPS in a browser, packaging.
