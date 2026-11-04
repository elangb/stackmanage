# ADR 0003: managed hosts, internal TLS and browser CA trust

Status: accepted for Linux x64. Date: 2026-11-04.

## Context

Phase 1 sites were HTTP-only and could not use a real local domain. The requested workflow needs `https://name.test` without public DNS or ACME. Two privileged boundaries are involved: the system hosts file and the OS certificate store.

## Decisions

1. **Managed hosts block.** Only a marked block may be changed. Unrelated lines are preserved, the existing block is parsed strictly, the write is atomic, and removal clears only the managed block. When `/etc/hosts` is not writable, the existing platform helper plans `pkexec` with separate argv; no shell interpolation and no implicit elevation. A failed hosts write is reported as a partial site result, never as a successful resolvable domain.
2. **Internal TLS.** A TLS site is rendered as `https://host:port { tls internal }`. Global `auto_https disable_redirects` keeps Caddy from opening privileged port 80 while still issuing internal certificates. Sites remain bound to `127.0.0.1`.
3. **User-scoped browser trust.** On Linux, the Caddy root CA is added to the user's NSS database (`~/.pki/nssdb`) and any existing Firefox profile with `cert9.db`, using `certutil` with an argument array. No administrator access is required. System trust is deliberately **not** modified and is reported as `not-modified`.
4. **Explicit trust action.** Trust is a separate operation from site creation. The UI shows the CA state and requires the user to press “Trust local CA”; tests use an isolated NSS database.
5. **Windows.** The CA/status code reports `unsupported` instead of simulating a trust store. Windows root-store integration remains unverified and needs a dedicated elevated plan.
6. **Document roots.** Sites still live inside the managed sites directory. This prevents the domain/TLS feature from becoming an arbitrary filesystem write primitive.

## Consequences

- A local `.test` domain can be configured, resolved through the managed hosts block, served over internal TLS, and its CA trusted for Chromium/Chrome/Edge and existing Firefox profiles on Linux.
- The system trust store and Chrome/Firefox UI acceptance are not claimed; browser-level verification remains a QA task.
- Hosts changes may require a polkit prompt. Without it the site is configured but the domain is not resolvable; the result is partial with a stable message key.
- Caddy's own attempt to auto-install its CA via `sudo` fails harmlessly in an unprivileged worker; StackManage does not rely on it.

## Evidence

- `STACKMANAGE_INTEGRATION=1` TLS test: temporary hosts + NSS DB, custom `.test` site, HTTPS 200 with the CA, NSS trust status becomes `trusted`, hosts entry removed with the site.
- Unit tests: internal TLS rendering, managed-block clear, isolated `certutil` trust, missing-CA and unsupported-platform behavior.
- Real Electron UI: installing/starting Caddy and adding a TLS site through the form; payloads are JSON-normalized because `contextBridge` cannot clone Vue proxies.
