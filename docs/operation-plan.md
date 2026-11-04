# Phase 0 implementation and failure-boundary plan

## Scope and authorization

Original implementation lives exclusively in `stackmanage/`; the existing FlyEnv tree is preserved. User explicitly authorized a separate pnpm/Turbo workspace and agent branch, tests and reports. No module-specific exceptions to ownership rules are authorized. No legacy code/assets are imported. Existing legacy `ModuleInstalledItem` is not available in this independent workspace: future adapters must share the new `ServiceManager` lifecycle rather than copy legacy implementations. No service adapters or persistent module data are implemented in Phase 0.

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
