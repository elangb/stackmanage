# Frozen core API v1

Authority: `packages/core/src/v1/contracts.ts` and `ipc.ts`. Public export: `@stackmanage/core`. Treat the accepted Phase 0 commit as the v1 baseline. No legacy imports. All persisted/wire objects must pass their schema at the owning boundary; TypeScript interfaces alone are not validation. Schemas are strict and reject unknown fields.

| Contract/schema | Owner and implementation obligation |
|---|---|
| `ModuleDefinition` | Module-local adapter declares capabilities/dependencies and per-platform evidence; registration does not install anything |
| `ServiceManager`, `ServiceRef`, `ServiceState` | Worker; start/stop/restart share one lifecycle and verified PID/port ownership; companion stop is required |
| `VersionManager`, `VersionRecord`, `Installation` | Worker; vendor manifests, HTTPS artifact locations and SHA-256; verify provenance/digest before extraction |
| `Installer` | Worker; transactional staging, cancellation, safe extraction, preserve completed side effects; emit progress and one terminal event |
| `SiteManager`, `Site` | Worker plus platform adapter; validate config before replacing; report config/write/reload outcomes independently |
| `HostsManager`, `HostsEntry` | Platform adapter; atomic hosts write required, DNS refresh supplementary |
| `CertManager`, `Certificate` | Platform adapter; private keys never returned through renderer/MCP; privileged trust requires specific authorization |
| `ProjectEnv`, `ProjectEnvManager` | Module-local persisted environment; no global PATH mutation by default; secrets must be redacted from diagnostics |
| `StartupGroupManager`, `StartupGroup` | Ordered execution; dependencies must precede dependents; stop in reverse dependency order; preserve all per-item outcomes |
| `Scheduler`, `Schedule` | Worker lifetime; five-field cron, IANA timezone, overlap/missed runs skipped; scheduler validates cron semantics before save |
| `McpAuthorizer`, `McpPermission`, `McpTool` | Server owner; exact tool/resource grants, principal identity, expiry, deny by default; no wildcard grants |
| `PluginHost`, `PluginManifest` | Dedicated process and mediated host; API version, simple entry filename and explicit capabilities; no runtime in Phase 0 |
| `ModuleStorage` | Module-scoped `StorageGetAsync` / `StorageSetAsync`; adapter owns atomic persistence and validation |
| `Limits` | Product unlimited and telemetry false; operational bounds protect resources without license quotas |

## Result semantics

`OperationContext` supplies immutable operation identity, cancellation and progress emitter. `progress` never clears controller state; only `terminal` does. Sequence numbers support stale-event filtering. Exactly one terminal result per accepted operation is an implementation obligation. Duplicates with the same ID must attach to the existing job; a different overlapping mutation returns conflict. Persistent operation records are a later implementation, not a Phase 0 guarantee.

Results distinguish completed, partial, failed, cancelled and unknown. Per-item results distinguish completed, failed, skipped and unknown; non-completed items require reasons. Supplementary failures belong in warnings and cannot invalidate completed required work. Do not retry a mutation whose outcome is unknown without reconciliation.

## IPC v1

- Renderer bridge: `snapshot(): Promise<SnapshotResponse>`. No arguments or transport object exposure.
- Main request: `{apiVersion: 1}`. Exact trusted document and main frame only.
- Worker request: `{apiVersion: 1, id, method: 'health'}`.
- Worker response: `{apiVersion: 1, id, status: 'ready', pid}`.
- Phase 1 adds optional `platform`, `architecture`, `sitesRoot` facts and reports the implemented feature set; a Phase 0 `['bootstrap']` payload remains valid.
- Main rejects invalid/sender-forbidden traffic; worker drops invalid/unsolicited messages. Bad/unknown response IDs never resolve a pending request.
- Additive Phase 1 operation channels are enumerated in `v1/bridge.ts`; each has a strict schema and fixed channel name. There is no generic invoke/exec/shell channel.

## Phase 1 additions

| Surface | Contract |
|---|---|
| Install | `install` request is module-agnostic; the worker module validates the pinned vendor/version and never accepts a caller URL or digest |
| Lifecycle | `start`, `stop`, `restart` return one terminal `OperationResult`; progress frames are bounded sequence/stage/fraction values |
| Reads | `status`, `listServices`, `listInstallations`, `logsTail`, `sitesList` are short-lived typed reads |
| Sites | `sitesApply` replaces the validated set; `sitesRemove` removes one id; roots must remain inside the managed sites directory |
| Events | Main forwards only a validated operation id, monotonic sequence, bounded stage key and 0–1 fraction; no worker text crosses to the renderer |

Data ownership: worker module owns installs, process handles, PID/port state and logs; renderer controllers own operation presentation only. No new Pinia store is introduced.

## Operational limits

| Limit | Default | Meaning |
|---|---:|---|
| IPC payload | 65,536 UTF-8 bytes | Enforced before parse/dispatch |
| Pending worker reads | 64 | Enforced in worker client |
| Read deadline | 5 seconds | Enforced; timeout is unavailable, not process-stop success |
| Concurrent installs | 2 | Declared policy; installer not implemented |
| Log chunk | 1 MiB | Declared policy; log transport not implemented |
| Services/sites/projects/licenses | Unlimited product policy | Real OS/disk/process constraints still apply |

## MCP scope inventory

All planned tools are enumerated in `McpToolSchema`: modules.list; versions.list; installations.list/install/remove; services.list/inspect/start/stop/restart; sites.list/apply/remove; hosts.apply; certificates.list/issue/trust; projects.list/resolve/save; groups.list/run; schedules.list/save/remove; configs.read/write; logs.read; operations.get/cancel; plugins.list/install/remove; terminal.open; shortcuts.run; system.info; screenshots.capture.

No tools are exposed in Phase 0. Tool-specific argument/result schemas, redaction, transport authentication, approval UX and integration tests must precede exposure. This is the complete planned v1 inventory, not a claim of exact parity with every current/future upstream MCP tool.

## Phase 3 additions (Node.js runtime)

| Surface | Contract |
|---|---|
| Runtime reads | `runtime.versions`, `runtime.status`, `runtime.list` take `{moduleId}` and return strict typed views. They never accept a URL, digest, path or shell command |
| Runtime install | `runtime.install` shares the module-agnostic `InstallRequest` shape but has its own fixed channel. The worker Node module accepts only module `node`, version `24.22.2`, and its own platform/architecture |
| Runtime uninstall | `runtime.uninstall` takes `{operationId, installationId}`. The worker resolves the ID through its persisted records and refuses any path outside the managed installations root |
| Runtime views | `RuntimeVersionView` includes pinned source/SHA-256/archive and `tested` (execution evidence, not availability); `RuntimeInstallationView` exposes the binary path and a PATH-prepend plan but no shell mutation |
| Bridge names | `runtimeVersions`, `runtimeInstall`, `runtimeStatus`, `runtimeList`, `runtimeUninstall` with fixed channels. No generic invoke/exec/shell channel is added |
| Progress | Runtime install/uninstall stream the same bounded progress frames; exactly one terminal `OperationResult` settles each accepted operation |

The Node module is additive: Caddy channel names, pins and lifecycle semantics are
unchanged. Windows x64/arm64 and Linux arm64 artifacts are pinned by official SHA-256
values but remain `unverified`; only Linux x64 has execution evidence.

## Phase 4 additions (Nginx)

| Surface | Contract |
|---|---|
| Nginx reads | `nginx.versions`, `nginx.status`, `nginx.list` take `{moduleId:'nginx'}` and return strict typed views. `nginx.logs` takes a bounded `maxBytes`; `nginx.config` takes no caller fields |
| Nginx install | `nginx.install` reuses the module-agnostic `InstallRequest` shape but has its own fixed channel. The worker accepts only module `nginx`, version `1.30.6`, and its own Linux platform/architecture; callers cannot name a URL, digest, configure flag or prefix |
| Nginx uninstall | `nginx.uninstall` takes `{operationId, installationId}`. The worker resolves the ID through its persisted record, refuses a running service, and refuses any path outside the managed installations root |
| Nginx lifecycle | `nginx.start`, `nginx.stop`, `nginx.reload` take `{operationId, timeoutMs?}` for the single managed instance. Reload validates the candidate config with `nginx -t` before sending SIGHUP |
| Nginx views | `NginxVersionsView` exposes source/Windows pins, archive kind, supported and tested flags. `NginxStatusView` exposes install facts plus a bounded service view. `NginxLogsView` exposes the managed log path and a bounded tail. `nginx.config` returns the read-only `ConfigReadView` |
| Bridge names | `nginxVersions`, `nginxInstall`, `nginxStatus`, `nginxList`, `nginxUninstall`, `nginxStart`, `nginxStop`, `nginxReload`, `nginxLogs`, `nginxConfig` with fixed channels. No generic invoke/exec/shell channel is added |
| Progress | Nginx install/lifecycle stream the same bounded progress frames; exactly one terminal `OperationResult` settles each accepted operation |

The Nginx module is additive: Caddy and Node channel names, pins and lifecycle
semantics are unchanged. Linux x64 is the only Nginx target with execution
evidence. Linux arm64 builds from the same pinned source but remains unverified;
the official Windows zip is pinned but Windows execution is explicitly
`unsupported` in this build.

Nginx process identity uses the recorded executable and OS start token on Linux.
The optional environment token used by Caddy cannot be relied on for Nginx
because the vendor master rewrites its process environment; a recycled PID is
still rejected by executable and start-token mismatch.

## Phase 6 additions (Redis)

| Surface | Contract |
|---|---|
| Redis reads | `redis.versions`, `redis.status`, `redis.list` take `{moduleId:'redis'}` and return strict typed views. `redis.logs` takes a bounded `maxBytes` |
| Redis install | `redis.install` reuses the module-agnostic `InstallRequest` shape but has its own fixed channel. The worker accepts only module `redis`, version `7.2.7`, and its own Linux platform/architecture; callers cannot name a URL, digest, build flag, port, prefix or config path |
| Redis uninstall | `redis.uninstall` takes `{operationId, installationId}`. The worker resolves the ID through its persisted record, refuses a running/unknown service, and refuses any path outside the managed installations root |
| Redis lifecycle | `redis.start` and `redis.stop` take `{operationId, timeoutMs?}` for the single managed instance. Start binds `127.0.0.1:16379`, runs in the foreground under the worker, and reports readiness only when the managed `redis-cli ping` returns `PONG` |
| Redis views | `RedisVersionsView` exposes the Linux source/SHA-256 pins and honest supported/tested flags. `RedisStatusView` exposes install facts plus a bounded service view (state, PID, loopback endpoint, config/data/log/pid paths). `RedisLogsView` exposes the managed log path and a bounded tail |
| Bridge names | `redisVersions`, `redisInstall`, `redisStatus`, `redisList`, `redisUninstall`, `redisStart`, `redisStop`, `redisLogs` with fixed channels. No generic invoke/exec/shell channel is added |
| Progress | Redis install/lifecycle stream the same bounded progress frames; exactly one terminal `OperationResult` settles each accepted operation |

The Redis module is additive: Caddy, Node and Nginx channel names, pins and
lifecycle semantics are unchanged. Linux x64 is the only Redis target with
execution evidence. Linux arm64 builds from the same pinned source but remains
unverified. Redis upstream publishes no supported native Windows build, so
Windows is explicitly `unsupported`; no unofficial fork is used and no Windows
artifact is pinned.

Redis process identity uses the recorded executable and OS start token on Linux.
The instance is never daemonized: the worker owns the child, and stop/reconcile
verify identity before signalling. Authentication/ACL, replication, cluster mode,
TLS and persistence tuning are not part of this contract.
