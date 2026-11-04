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
