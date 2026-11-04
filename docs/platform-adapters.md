# Platform adapter (`packages/platform`)

Scope: Linux (x64/arm64) implemented and tested unprivileged; Windows x64/arm64
**planning only and unverified**. Nothing in this package claims end-to-end
platform acceptance, privileged execution success, or vendor availability.

## Design rules

1. **No shell.** Every command is a `CommandSpec { file, args }` spawned with
   `shell: false`. Caller data is never concatenated into a command line.
   PowerShell uses `-EncodedCommand` (UTF-16LE → base64) with single-quoted
   literals; POSIX helpers receive data as separate `argv` elements.
2. **Ports, not globals.** Host facts, environment, filesystem, process runner,
   elevation probe and clock are injected. Tests use temp directories and fakes
   and never touch `/etc/hosts`, the trust store, or the registry.
3. **Plan ≠ execute.** Adapters return `CommandPlan` with an explicit
   `privilege` and `execution: 'verified' | 'unverified'` field. `sudo` is never
   invoked automatically. `pkexec` is used only when already present, and the
   privileged hosts path is planned but not executed by tests.
4. **Truthful results.** `buildResult` derives `completed | partial | failed |
   unknown` from item outcomes and validates against the frozen
   `OperationResultSchema`; a supplementary warning (for example a later DNS
   refresh) never invalidates a completed required write.

## Modules

| File | Responsibility | Linux | Windows |
|---|---|---|---|
| `detect.ts` | `linux`/`win32` + `x64`/`arm64`; darwin reported unsupported | tested | tested (pure) |
| `paths.ts` | Data roots: portable env, explicit override, `LOCALAPPDATA`/`APPDATA`, `XDG_DATA_HOME`, `HOME` fallback | tested | tested (pure) |
| `hosts-block.ts` | Strict marker block parse/merge, entry validation, idempotence | tested | shared |
| `scripts.ts` | Deterministic POSIX `sh` and PowerShell helper generation | executed in temp dirs | generated only |
| `hosts-linux.ts` | Direct atomic write + optional `pkexec` helper | direct write executed; elevated path executed only with a stub `pkexec` | n/a |
| `hosts-windows.ts` | `-EncodedCommand` plan, staged block, backup path | n/a | plan only, unverified |
| `trust.ts` | Distro detection, `update-ca-certificates` / `update-ca-trust` / `trust`, `certutil` | plan only | plan only |
| `ports-capability.ts` | Port risk, `setcap` plan, high-port fallback, `getcap` parsing | plan only | n/a |
| `autostart.ts` | XDG desktop entry, `HKCU\...\Run` plan | write/remove tested | plan only |
| `shell-hooks.ts` | bash/zsh/fish/PowerShell/cmd hooks with round-trip parsing | generated + bash executed | generated only |
| `process-kill.ts` | Process-group / `taskkill` plans, Job Object note | plan only | plan only |
| `health.ts` | Real loopback TCP probe, owned disposable child stop | executed | probe portable |
| `capabilities.ts` | Capability matrix; never `supported` without evidence | n/a | n/a |

## Failure boundaries applied

- Hosts write is the required dependency; backup failure is reported but a
  successful atomic replace still counts as completed.
- A malformed existing managed block is refused, never repaired or overwritten.
- Invalid entries are rejected individually with a reason; a rejected entry
  does not authorise writing its siblings.
- Elevation that is absent returns `unavailable` with the exact plan and does
  not fall back to `sudo`, a retry, or a silent non-privileged write.
- An elevated run that times out returns `failed` with an explicitly **unknown**
  file state instead of assuming success or retrying.
- A helper exit `0` is not trusted: the file is re-read and re-parsed, and a
  verification mismatch is a failure.

## Known gaps (deliberately not hidden)

- Real `pkexec` execution (polkit prompt, authentication) is not covered by
  automated tests; only staging, argv layout and helper semantics are.
- Windows: hosts write, trust store, autostart registry write, process tree
  kill, and Job Object containment are planned but never executed. No Windows
  runtime evidence exists.
- `cap_net_bind_service` is never applied; only planned.
- Certificate issue/renewal is not implemented (`NOT_IMPLEMENTED` results).
- No packaging, signing, or installer behaviour lives in this package.
