# ADR 0001: original nested workspace and process boundaries

Status: accepted for Phase 0. Date: 2026-11-04.

## Context

The clean baseline is the legacy project at commit `7507ccd`. User requires preserving legacy, an original implementation, separate agent branches, a runnable foundation, no new module Pinia, and evidence-based acceptance. The official feature page and GitHub README are scope references, not implementation or asset sources.

## Decisions

1. **Placement:** all new files live under `stackmanage/`. pnpm workspace and Turbo do not modify legacy package scripts, source or assets. Each later agent starts from this commit on its own branch; integrate through explicit commits.
2. **Stack:** Electron 45.2.2, Vue 3.5.44, Vite 8.3.5, TypeScript 5.9.3, Zod 4.6.7, Node 24, pnpm 10.32.1. Exact versions and lockfile are reproducible; registry existence was checked. TypeScript 5.9 is deliberately conservative for Vue tooling. Latest is not a support or security guarantee.
3. **Processes:** renderer owns presentation only; main owns windows, IPC authorization and the worker child; fork worker will own module processes/PID/ports and companions. Renderer state is never process-liveness truth. A future privileged helper is separate from ordinary worker jobs.
4. **IPC:** only `stackmanage:v1:snapshot` is registered. Validate both directions with strict Zod schemas, exact main-frame document and webContents identity. Preload bundles dependencies into CJS for sandbox compatibility. No generic invoke/send, shell, filesystem or arbitrary URL access is exposed. Deny permissions, new windows, webviews and navigation. Production CSP has no network connections; dev permits only local Vite HMR.
5. **Module state:** use module-local singleton controllers and `reactiveBind`; view inputs remain component-local. Future domain persistence uses module-scoped storage methods. Service lifecycle flows through shared `ServiceManager`; module-specific arguments and policies remain within the module. This workspace does not import legacy lifecycle code.
6. **Contracts:** v1 schemas are the wire authority and interfaces define manager responsibilities. Services, installer, project/site/certificate/group/scheduler operations are contracts only. Breaking changes require `v2` or an approved explicit migration before implementation agents proceed.
7. **Plugins:** versioned manifest, explicit requested capabilities, deny by default; no plugin loader yet. Later implementation must isolate plugin execution in a dedicated process and mediate capabilities at the host. A Node child process alone is not an OS security sandbox. Never evaluate third-party plugins in renderer/main. Install verification and platform containment require separate design/evidence.
8. **Platform:** adapters for Windows/Linux/macOS are explicit, no OS-name inference of vendor support. Native packaging, privilege execution, trust stores, hosts, environment mutation and process identity validation are deferred. Unverified is distinct from unsupported.
9. **Privacy/product:** no telemetry SDK or product license counters/gates. Turbo invocations explicitly set `TURBO_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1`. Developer dependency downloads and user-requested downloads are not telemetry. No remote fonts/assets.
10. **UI:** a minimal dark shell with native controls, visible focus, live status, system fonts and responsive layout. No fake service cards or clickable unimplemented features. i18n owns all user-facing view labels.

## Trade-offs

Electron adds bundle size but provides a consistent desktop shell and narrow preload boundary. A nested monorepo duplicates tooling but protects legacy. Worker recovery is explicit (restart application after worker death); Phase 0 does not add crash loops or silently replay jobs. In-memory snapshot reads are safe to retry; future mutations require idempotency and unknown-outcome handling.

## Acceptance

Schema, controller and actual fork tests plus an actual Electron round-trip establish the foundation. They do not establish service correctness, Windows support, vendor availability, packaging/signing or overall user acceptance.
