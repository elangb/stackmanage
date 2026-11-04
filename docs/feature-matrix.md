# Full requested scope and evidence matrix

Status baseline: **except for the Linux x64 Caddy vertical slice recorded below, every product feature is unverified and unimplemented in StackManage**. A vendor appearing in official FlyEnv material is scope evidence only, never StackManage execution evidence or vendor availability. Windows/Linux/architecture availability is unknown unless a later row links an actual vendor artifact and execution report. Phase 0 bootstrap is tracked separately in `reports/phase0.md`.

Evidence sources consulted 2026-11-04:

- [Official Indonesian features](https://flyenv.com/id/features): runtime, web, database, infrastructure, workflow, AI and plugin categories.
- [Official GitHub README](https://github.com/xpf0000/FlyEnv/blob/master/README.md): native stack, project workflows, AI/MCP, downloadable platforms.
- Local baseline `7507ccd`, `LICENSE` heading: BSD 3-Clause, despite stale MIT wording in legacy `AGENTS.md`. No legal conclusion is made here; legal agent owns review. No source/assets were copied.

**U** = not implemented, not tested, vendor/platform availability unverified. Each semicolon-separated feature is independently U; completion of one does not establish siblings. Owners below are future implementation responsibilities.

| Category | Explicit feature inventory | Owner / acceptance evidence needed | Status |
|---|---|---|---|
| Runtimes | PHP (versions, extensions, FPM); Node.js (versions/project selection); Python (versions/environments); Java (JDK); Go; Erlang; Ruby; Rust; .NET; Zig; Bun; Deno; Flutter SDK; Gradle | modules + worker; real install/version-switch/run/uninstall per supported OS/arch | Node.js: **partial** on Linux x64 only (pinned install, binary `--version`, uninstall, PATH-prepend plan; shell hooks/project env/version switch U); PHP/Python/Java/Go/Erlang/Ruby/Rust/.NET/Zig/Bun/Deno/Flutter/Gradle: U each |
| Web servers | Nginx; Apache; Caddy; FrankenPHP; Tomcat; static HTTP server | modules + worker; config validation, start/health/reload/stop and port conflicts | Caddy: **partial** on Linux x64 only (real pinned install + HTTP 200 + lifecycle/reconcile evidence in `reports/phase1-core.md`); Nginx/Apache/FrankenPHP/Tomcat/static: U; Caddy Windows/arm64: U |
| Sites/HTTPS | local domains; aliases; document roots; per-site runtime; reverse proxy; HTTPS; mkcert; hosts editing; certificate issue/renew/remove/trust | sites + platform; actual local requests, trust-store and hosts write/rollback tests | **Partial Linux x64:** managed hosts block, `.test` aliases, internal TLS, isolated NSS trust, HTTPS 200 with CA, and real headless Google Chrome acceptance without bypass flags (see `reports/phase2-hosts-tls.md`); Firefox/Edge, Windows and system trust still U |
| Databases | MySQL; PostgreSQL; MariaDB; MongoDB; Qdrant; ClickHouse; Neo4j | modules + worker; versioned install, initialization, connection, clean shutdown | U each |
| Database panels | phpMyAdmin; pgAdmin; DBGate; Redis Commander | module-local controller + worker; panel readiness, parent/companion shutdown, credentials handling | U each |
| Cache/messaging/search/mail | Redis; Memcached; RabbitMQ; Elasticsearch; Meilisearch; Typesense; ZincSearch; Mailpit | modules + worker; real protocol probes, logs and shutdown | U each |
| DNS/network | Numa; DNS server; FTP server; Cloudflared; Cloudflare tunnels | modules + platform; vendor identity/download and native support must be researched, DNS/FTP/tunnel integration tests | U each |
| Storage/containers | MinIO; RustFS; Podman | modules + platform; native availability, storage integrity, VM/container prerequisites and shutdown | U each |
| Distributed infrastructure | R-Nacos; Consul; etcd; Temporal | modules + worker; dependencies, native distributions, protocol probes and recovery | U each |
| Workflow | startup groups; project environments; per-project versions; project start/stop commands and ports; cron/scheduler; user-defined modules; terminal; shortcuts; config editor; log viewer; Git integration | module controllers + worker; progress/re-entry, environment isolation, PTY cleanup, per-item failure semantics | U each |
| MCP tools | full inventory in `contracts-v1.md`, covering discovery, versions, installation, lifecycle, sites, hosts/certs, projects, groups, schedules, configs/logs, jobs, plugins, terminal, shortcuts, system and screenshots | MCP server + shared managers; schema validation, grants/expiry/redaction, real transport/client tests | U each |
| AI clients | Claude Code; Codex; OpenCode; Kimi; Antigravity; GitHub Copilot; Hermes Agent; OpenClaw | AI module controllers; verify vendor identity/version/OS distribution and client-specific MCP registration | U each |
| AI/automation | n8n; Ollama; CLIProxyAPI; assistant; screenshot capture; optimizer | modules + worker/platform; real integrations, explicit permissions, model/runtime requirements, optimizer semantics need specification | U each |
| Plugin modules | MySQL cluster; MariaDB cluster; Kafka; llama/llama.cpp; OpenSearch; SQL Server; Dameng; shortcuts plugins | plugin host + module adapter; vendor availability/licensing left to research/legal, install/cluster recovery/stop tests | U each |
| Plugin platform | discovery/catalog; manifests; install/update/remove; enable/disable; permissions; isolated execution; user modules | plugin SDK + host; signature/checksum, path traversal, isolation, version compatibility and capability tests | U each |
| Product limits | unlimited licensing; no license activation gate; no artificial service/site/project/version quotas; telemetry disabled | core policy + all feature owners; policy exists in Phase 0, actual feature behavior remains unverified | U for feature-wide acceptance |
| Platform behavior | Windows native; Linux native; paths with spaces/Unicode; offline shell; process identity; privilege requests; per-user data; uninstall cleanup; accessibility; five-language parity | platform + QA; actual OS runs and failure scenarios | U each beyond recorded bootstrap evidence |
| Distribution | six requested release artifacts, checksums, signatures/provenance, install/upgrade/uninstall | release agent + real Windows/Linux machines | **Partial:** Linux `.deb` x64 and arm64 built; x64 packaged-app smoke passed; RPM and Windows blocked by toolchain; signing/upgrade/uninstall U |

## Six-artifact planning assumption

The task says six artifacts without enumerating formats. To unblock planning, reserve these six Windows/Linux outputs (confirm with parent/product owner before release implementation):

1. Windows x64 installer `.exe`.
2. Windows x64 portable `.exe`.
3. Linux x64 `.deb`.
4. Linux arm64 `.deb`.
5. Linux x64 `.rpm`.
6. Linux arm64 `.rpm`.

No artifacts are produced by Phase 0; `pnpm build` bundles code only. macOS is represented in contracts as a future platform, not accepted or included in these six. Architecture support and exact artifact naming are not verified. Do not replace real Windows tests with cross-compilation.

## Evidence progression rule

Every later feature row must add: adapter path, upstream artifact URL/version/digest, vendor OS/arch support evidence, reproducible commands, positive/negative/lifecycle cases, actual machine OS/arch, logs and result. Distinguish implemented from tested and tested from accepted. Unknown vendor distribution must remain unknown; never substitute a similarly named vendor silently.

## Phase 1 evidence

| Slice | Adapter path | Evidence | Status |
|---|---|---|---|
| Caddy 2.11.8 install | `apps/worker/src/modules/caddy/{download,extract,installer}.ts` | Official GitHub release; SHA-512 from vendor checksums plus locally computed SHA-256; real download and `caddy version` in `STACKMANAGE_INTEGRATION=1` test | Verified Linux x64 only |
| Caddy start/stop/status/reconcile | `apps/worker/src/modules/caddy/{service,process}.ts` | Real process, HTTP 200 from a generated site, stale PID reconciled after simulated worker death | Verified Linux x64 only |
| Caddy local sites | `apps/worker/src/modules/caddy/{sites,caddyfile}.ts` | Caddyfile rendered for managed roots, validated with `caddy validate`, restart warning when running | Verified by unit/integration tests, not browser acceptance |
| Hosts + internal TLS | `packages/platform/src/hosts-*.ts`, `apps/worker/src/modules/caddy/{sites,certificates}.ts` | Temporary hosts/NSS integration: `.test`+alias, HTTPS 200 with CA, NSS trust, hosts cleanup | Verified Linux x64 only; browser/system trust unverified |
| Desktop shell | `apps/desktop/src/renderer`, `packages/i18n`, `packages/ui` | Sandboxed Electron smoke, five-locale key parity, controller tests | Shell/UI only; not platform acceptance |
| Nginx / HTTPS / hosts | — | Not implemented | U |



## Phase 3 evidence

| Slice | Adapter path | Evidence | Status |
|---|---|---|---|
| Node.js 24.22.2 install | `apps/worker/src/modules/node/{download,extract,installer}.ts` | Official `nodejs.org` tarball and SHASUMS256.txt; pinned SHA-256; `bin/node --version` equals `v24.22.2`; staging + atomic rename + rollback; real-network opt-in test | Verified Linux x64 only |
| Node.js uninstall | `apps/worker/src/modules/node/installer.ts` | Recorded installation only; managed-root and binary path guards; real-network test asserts directory removal and empty list | Verified Linux x64 only |
| Node.js bridge/UI | `packages/core`, `apps/desktop` | Typed `runtime.*` worker/bridge channels, module-local controller, Runtimes page, five-locale keys | Unit/controller/smoke evidence; Windows/arm64 unverified |
