# Linux system trust helper

`packages/platform/src/system-trust-linux.ts` prepares the explicit, privileged step that adds StackManage's local Caddy CA to the **system** trust store.

## Behaviour

- `status()` only reads `/etc/ssl/certs/ca-certificates.crt` and compares the managed CA. It reports `trusted`, `untrusted`, `missing-certificate` or `unknown`.
- `install()` stages a fixed `/bin/sh` helper and runs it only through a supplied elevation provider (`pkexec`).
- The helper receives the certificate path, target directory and file name as separate argv elements. It never interpolates a shell string, never uses `sudo` implicitly and never accepts a caller-controlled command.
- `remove()` removes only the exact managed target and refreshes the bundle; it is not wired to the UI yet.
- Tests use an in-memory filesystem and a fake runner. No real root action runs in the test suite.

## Why it is not automatic

The system trust store is machine-wide. Installing into it from an unattended process would be a privileged side effect without consent. The helper therefore exposes a plan/status API; the UI must call it from an explicit user action and then verify the CA bundle.

## Current integration

`CaddyCertificates.status()` now reports the read-only `systemTrust` state (`trusted`/`untrusted`/`unsupported`/`unknown`). The user-scoped NSS trust remains the default browser path. A system-trust button and polkit/VM execution are still pending.
