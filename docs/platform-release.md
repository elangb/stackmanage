# Platform package build and release verification

Applies to `packages/platform`. This is not a product release checklist; it
covers only how this package is validated and how its privileged boundaries are
kept honest.

## Reproducible verification

Run from `stackmanage/`:

```sh
pnpm install --frozen-lockfile
pnpm --filter @stackmanage/platform typecheck
pnpm exec eslint packages/platform --max-warnings 0
pnpm exec vitest run packages/platform
pnpm --filter @stackmanage/platform build
pnpm test          # whole workspace, no regression in other packages
pnpm check         # typecheck + lint + test + legal + build
```

`pnpm check` is the gate used before integration. Ordering matters: typecheck
and lint fail before tests run, so a type regression never reaches a green test
count.

## Test-isolation invariants (asserted, not assumed)

- No test writes `/etc/hosts`, `/etc/ca-certificates`, `/etc/pki`, or the
  Windows registry. Tests use `mkdtemp` plus an injected `FileSystemPort`.
- `hosts-elevated-e2e.test.ts` asserts the real `/etc/hosts` bytes are unchanged
  before/after the suite.
- Elevated-path coverage uses a stub `pkexec` in a temp `PATH` that `exec`s the
  helper as the invoking user. It proves staging/argv/helper/verification
  composition, not polkit authentication.
- `ci/platform.yml` fails the Linux job if tests run as uid 0, so an accidental
  root dependency cannot hide.
- Environment is isolated with `STACKMANAGE_DATA_HOME` and
  `STACKMANAGE_CACHE_HOME`; nothing reads the checkout path.

## Privileged-change protocol (required before any real execution)

Any future change that would actually execute a privileged operation must, in
this order:

1. State the exact `CommandSpec` (`file` + full `args`) and the elevation wrapper.
2. Confirm the target path, the user-visible prompt source, and the ownership
   condition (the PID/binary the operation may touch).
3. Record the rollback: hosts restore from the generated timestamped backup;
   trust anchor removal via the distro's own directory plus refresh; capability
   removal via `setcap -r <binary>`.
4. Obtain explicit human approval. Never enable `sudo`, a NOPASSWD rule, or an
   automatic retry to make a test pass.

## Windows "unverified" rule

Windows adapters return plans with `execution: 'unverified'` and
`privilege: 'unverified'`. `WindowsHostsManager.apply` reports an `unknown`
terminal result plus a `hosts.windowsExecutionUnverified` warning. Do not
promote any Windows capability to `supported` or `verified` without a real
Windows host run recorded in `docs/reports/phase1-platform.md`-style evidence.
Cross-compilation is not verification.

## Rollback

| Change | Rollback |
|---|---|
| Hosts managed block | Restore the newest `<hosts>.stackmanage.bak-<iso>` written before the replace |
| XDG autostart | `LinuxAutostart.disable()` removes only its own entry; delete manually otherwise |
| Shell hook | Remove everything between `# >>> StackManage shell hook >>>` and `# <<< StackManage shell hook <<<` |
| Trust anchor | Delete the copied anchor, then re-run the distro refresh command |
| `cap_net_bind_service` | `setcap -r <binary>` (requires the same elevation) |

## Smoke checks after integration

1. `node -e "import('@stackmanage/platform').then(m => console.log(m.platformImplementationStatus))"` via the workspace importer prints `partial`.
2. `detectPlatform` on the host returns the real platform/arch.
3. `probePort` against a listening loopback port returns `open`.
4. A hosts `preview()` in a temp directory returns `changed: true` for a new entry and `changed: false` on rerun.
