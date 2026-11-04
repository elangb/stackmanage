# Phase 0 implementation and failure-boundary plan

## Scope and authorization

Original implementation lives exclusively in `stackmanage/`; the existing legacy tree is preserved. User explicitly authorized a separate pnpm/Turbo workspace and agent branch, tests and reports. No module-specific exceptions to ownership rules are authorized. No legacy code/assets are imported. Existing legacy `ModuleInstalledItem` is not available in this independent workspace: future adapters must share the new `ServiceManager` lifecycle rather than copy legacy implementations. No service adapters or persistent module data are implemented in Phase 0.

Checklist: no Pinia; no `config.setup`; future module persistence uses module-scoped `StorageGetAsync`/`StorageSetAsync`; module-only policies stay in module directories. `reactiveBind` binds singleton operation state; component state contains only locale and presentation. Public contracts stay module-agnostic.

## Ownership and operation contract

| Operation/state | Owner / lifetime | Start / intermediate / terminal | Duplicate / cleanup / service interaction | Verification |
|---|---|---|---|---|
| Snapshot request | bootstrap singleton renderer controller, application lifetime | refresh / pending / ready or failed | same in-flight promise; immutable empty request; always clears pending; no mutation or service launch | duplicate, failure/retry, page re-entry tests |
| Worker health RPC | main `WorkerClient`, child-process lifetime | validated request / none / validated matching response, timeout, exit, send error | bounded pending map; IDs correlate concurrent reads; reject pending on exit/close; remove listeners and timer; no implicit retry | malformed IPC, actual fork health, timeout, close tests |
| Worker process | main owns worker child; worker will own service children | spawn / health / exit | one worker per app; quit disconnects and terminates worker; parent disconnect terminates worker | fork/disconnect integration test; desktop smoke |
| Locale | mounted view | select / none / rendered | page-local; no persistence | locale key parity test |
| Future install/service jobs | module-local controller plus worker module | queued / progress / completed, partial, failed, cancelled, unknown | immutable request; explicit operation ID; same-ID re-entry returns same operation; lifecycle shared through ServiceManager; companions stop with parent | required downstream lifecycle suites, not claimed here |

## Failure boundaries

1. Build shared dependencies, worker and desktop bundles: required dependencies. Failure stops dependent builds and launch, never reports launch success.
2. Renderer request validation, sender authorization and worker health response: required for a trustworthy snapshot. Invalid requests fail locally; wrong/unsolicited response IDs cannot complete another request. Timeout means unavailable, not successful worker termination.
3. Worker failure does not erase the application shell. Snapshot controller reports failure and allows an explicit retry; no automatic replay of mutations exists.
4. Shutdown of the worker is required. Disconnect is followed by bounded termination; failure is observable. Future service shutdown must retain per-service results, never equate missing PID evidence with successful stop.
5. Tests/checks are independent evidence items. Record every failed check even if another passed.
6. Future hosts write is required, DNS refresh supplementary: preserve the write outcome, attach a warning and never replay the write. Invalid process candidates are skipped independently with reasons. Startup groups collect per-item outcomes and preserve ordering; required dependency failure skips dependents only.

Review before commit: examine every throw/reject/early return against these boundaries. There are no service writes, install side effects, privilege escalation or batch execution in this phase. Unknown vendor/platform availability remains unknown.

## Phase 3 runtime operation contract (Node.js)

Authorization: user authorized a Node.js runtime module, a separate `agent/node-runtime`
branch and Phase 3 tests/report. No exception to the default module constraints is needed:
there is no Pinia store, no `config.setup`, module persistence is `StorageGetAsync`/
`StorageSetAsync`, and all Node-only types/helpers live under
`apps/worker/src/modules/node` plus the renderer-local `runtime` controller.

| Operation/state | Owner / lifetime | Start / intermediate / terminal | Duplicate / cleanup / service interaction | Verification |
|---|---|---|---|---|
| Runtime versions/status/list | worker Node module; worker lifetime | read / none / typed view or typed error | short-lived read; never mutates controller operation state; a corrupt/missing record is treated as absent | schema, unsupported-platform and path-guard tests |
| Runtime install | renderer `runtimeController` singleton plus worker Node installer | `runtime.preflight` / download, extract, validate, commit progress / one `OperationResult` | same operation ID attaches through the worker inflight map and controller in-flight promise; a different overlapping install returns `CONFLICT`; idempotent when a valid pinned binary exists; staging removed in `finally`; previous install restored if commit fails | unit, idempotency, conflict, checksum, traversal and real-network tests |
| Runtime uninstall | renderer `runtimeController` singleton plus worker Node installer | `runtime.uninstall` progress / one `OperationResult` | only a recorded installation is addressed; directory and binary must resolve inside the managed installations root; file removal is required, record cleanup failure is a warning; no process to stop | managed-root guard, cleanup and missing-record tests |
| Runtime progress | controller handler | subscribe once / validated operation ID + monotonic sequence / listener detached on page teardown | foreign, replayed and stale frames are dropped; no text beyond a bounded stage key and fraction crosses the bridge | controller dedupe/progress/cleanup tests |

Failure boundaries: the official archive SHA-256 is a required dependency. The
supplementary SHASUMS256.txt read is not: an unavailable list becomes a warning, while a
list entry that contradicts the pinned digest stops the install. Extraction rejects
traversal, outside-top-level entries and special files and never creates symlinks; a
linked `bin/node` fails the required binary check. The real binary `--version` must equal
`v24.22.2` before commit. No Windows/arm64 execution is claimed.

## Phase 4 Nginx operation contract

Authorization: user authorized an Nginx web-server module, a separate
`agent/nginx` branch and Phase 4 tests/report. No default module constraint is
relaxed: there is no Pinia store, no `config.setup`, persistence uses
`StorageGetAsync`/`StorageSetAsync`, and Nginx-only types, pins, paths and policy
live under `apps/worker/src/modules/nginx` plus the renderer-local `nginx`
controller. Generic process/identity primitives were moved to
`apps/worker/src/shared/process.ts`; Caddy re-exports them unchanged.

| Operation/state | Owner / lifetime | Start / intermediate / terminal | Duplicate / cleanup / service interaction | Verification |
|---|---|---|---|---|
| Nginx versions/status/list/logs/config | worker Nginx module; worker lifetime | read / none / typed view or typed error | short-lived read; never mutates operation state; log and config paths are bounded to the managed home | schema, path-guard, unsupported-platform tests |
| Nginx install | renderer `nginxController` singleton plus worker Nginx installer | `nginx.preflight` / download, signature, extract, configure, build, install, validate / one `OperationResult` | same original operation ID attaches through the worker inflight map and controller in-flight promise; a different overlapping install returns `CONFLICT`; a valid pinned install is idempotent; staging is removed in `finally`; a previous prefix is restored if promotion/validation/persistence fails | preflight, checksum, signature, extraction, configure/build, idempotency and real-network tests |
| Nginx uninstall | renderer `nginxController` singleton plus worker installer | `nginx.uninstall` progress / one `OperationResult` | only a recorded installation is addressed; a running service is refused; directory and binary must resolve inside the managed installations root; record cleanup failure is a warning | managed-root, running-service, cleanup and missing-record tests |
| Nginx lifecycle | renderer `nginxController` singleton plus worker service manager | `nginx.preflight`/`config` / one `OperationResult` | one mutation per instance; duplicate calls attach to the in-flight promise; start checks the loopback port, validates config, captures identity and waits for readiness; reload validates the candidate then sends SIGHUP; stop/reconcile verify executable and start token before signalling | real child start/HTTP 200/reload/stop, port-conflict, identity and stale-PID tests |
| Nginx progress | controller handler | subscribe once / validated operation ID + monotonic sequence / listener detached on application teardown | foreign, replayed and stale frames are dropped; no text beyond a bounded stage key and fraction crosses the bridge | controller dedupe/progress/cleanup tests |

Failure boundaries: the pinned SHA-256 is a required dependency; a mismatch
stops the install. The detached signature is supplementary when gpg or the
`.asc` file is unavailable (warning), but a bad signature, wrong key or failed
verification stops the install. Build tools and headers are required; missing
prerequisites return one actionable error before any download/build. `nginx -t`
is required before starting or reloading, and a rejected candidate never replaces
the live config. A failed start cleans up its own child and reports failure
instead of a running service. Uninstall cannot delete a running binary.

## Phase 6 Redis operation contract

Authorization: user authorized a Redis database module, a separate `agent/redis`
branch and Phase 6 tests/report. No default module constraint is relaxed: there
is no Pinia store, no `config.setup`, persistence uses `StorageGetAsync`/
`StorageSetAsync`, and Redis-only types, pins, limits, paths and policy live under
`apps/worker/src/modules/redis` plus the renderer-local `redis` controller.
Caddy, Node and Nginx behavior and the shared proxy-aware downloader are
unchanged; the shared process primitives are reused as-is.

| Operation/state | Owner / lifetime | Start / intermediate / terminal | Duplicate / cleanup / service interaction | Verification |
|---|---|---|---|---|
| Redis versions/status/list/logs | worker Redis module; worker lifetime | read / none / typed view or typed error | short-lived read; never mutates operation state; a corrupt/missing record is treated as absent; log path is bounded to the managed home | schema, path-guard and unsupported-platform tests |
| Redis install | renderer `redisController` singleton plus worker Redis installer | `redis.preflight` / download, checksum, extract, make, validate, commit / one `OperationResult` | same original operation ID attaches through the worker inflight map and controller in-flight promise; a different overlapping install returns `CONFLICT`; a valid pinned install is idempotent; staging is removed in `finally`; a previous prefix is restored if promotion/validation/persistence fails | preflight, checksum, extraction, idempotency, rollback and real-network tests |
| Redis uninstall | renderer controller plus worker installer | `redis.uninstall` progress / one `OperationResult` | only a recorded installation is addressed; a running or unverified service is refused; directory, server and CLI must resolve inside the managed installations root; record cleanup failure is a warning | managed-root, running-service, cleanup and missing-record tests |
| Redis lifecycle | renderer controller plus worker service manager | `redis.preflight` / one `OperationResult` | one mutation per instance; duplicate calls attach to the in-flight promise; start checks the loopback port, renders the private config, captures identity and waits for `redis-cli ping` = `PONG`; stop/reconcile verify executable and start token before signalling | real child start/PING/SET/GET/stop, idempotent start, port-conflict, identity and stale-PID tests |
| Redis progress | controller handler | subscribe once / validated operation ID + monotonic sequence / listener detached on application teardown | foreign, replayed and stale frames are dropped; no text beyond a bounded stage key and fraction crosses the bridge | controller dedupe/progress/cleanup tests |

Failure boundaries: the official SHA-256 is a required dependency; a mismatch
stops the install. `cc` and `make` are required; missing prerequisites return one
actionable error before any download/build. A failed `make` retries once with
`MALLOC=libc` (supplementary build strategy), but a real compiler failure still
stops the install. The real binaries must report 7.2.7 before promotion.
Readiness uses only the managed `redis-cli` reply `PONG`; a live process without
PONG is reported as failure/unknown, never as running. Stop reports `unknown`
when termination cannot be confirmed. Uninstall refuses a running or unverified
service and cannot delete a path outside the managed root. Windows is reported
`unsupported`; no unofficial fork is downloaded.

## Phase 7 read-only MCP operation contract

Authorization: user authorized a standalone read-only MCP server, a separate
`agent/mcp` branch and Phase 7 tests/report. No module boundary is changed: the
MCP server is a separate process, owns no service lifecycle, adds no Pinia store,
no `config.setup` persistence and no renderer IPC. It reads persisted worker
records and filesystem state directly.

| Operation/state | Owner / lifetime | Start / intermediate / terminal | Duplicate / cleanup / service interaction | Verification |
|---|---|---|---|---|
| Server process | CLI entry; stdio client lifetime | resolve trusted roots / none / stdio connection close or fatal config error | one stdio transport; no port; no child process; stderr only for fatal errors | config rejection, EOF, real spawned client tests |
| Tool reads | MCP server request; short-lived | strict input validation / none / one JSON text result | no writes, no record reconciliation, no retry, no shell; overlapping reads are independent | in-memory + stdio tests for success, missing, corrupt, oversized and path escape |
| Service status | MCP server read-only projection | read record / PID identity + loopback probe / `running`, `stopped`, `unknown` | identity mismatch or stale PID never claims running; record is not modified | dead PID, executable mismatch, token mismatch, verified running child |
| Logs/config | MCP server read-only projection | confined open / bounded read + redaction / bounded text or absent | missing file is explicit; path/symlink escape fails; secrets never returned | traversal, symlink, size-bound and redaction tests |

Failure boundaries: absent state is not an error and must not become a fabricated
installation/site/service. Corrupt or unsafe state is reported as unknown with a
reason; one bad record does not block other modules or other valid records.
Redaction is applied after reading and before output; a redaction failure cannot
cause a retry or a write. A missing Caddy/Nginx/Node root only affects that module.
No mutation exists to partially complete, so no mutation replay path is introduced.
Unknown tool names and invalid arguments are rejected by the protocol/schema before
any read. The future authenticated mutation bridge is out of scope.
