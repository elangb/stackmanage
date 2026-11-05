# Packaging

The first packaging slice targets Linux `.deb`. It is built with electron-builder 26.18.0 and Electron 45.2.2 from the already-built desktop bundles.

```sh
pnpm dist:linux:deb:x64
pnpm dist:linux:deb:arm64
```

Artifacts are written to `release/` (ignored by git). The x64 package was extracted and its packaged binary passed `STACKMANAGE_SMOKE=1` end-to-end: renderer → sandbox preload → main → fork worker.

## Status

| Artifact | Status |
|---|---|
| Linux `.deb` x64 | Built + packaged-app smoke passed |
| Linux `.deb` arm64 | Built; not executed on arm64 hardware |
| Linux `.rpm` x64/arm64 | Blocked: `rpmbuild` is not installed in this environment |
| Windows installer/portable | Blocked: no Windows runner and no Wine/NSIS in this environment |

## Known packaging issues

- `asar` is disabled because the worker is forked from a path inside the app; enabling it requires an `asarUnpack`/fork-path proof.
- `electron-builder` resolves Electron from the legacy workspace root unless `electronVersion` is pinned. The config pins 45.2.2 explicitly.
- `THIRD_PARTY_NOTICES.md` and `LICENSE` are included under `resources/`; full Electron/Chromium notices still need to be bundled at release.
- Package metadata still uses placeholder maintainer/homepage values; replace them before a public release.
- Linux icon is original (`build/icon.png`); Windows `.ico` and macOS assets are not prepared.

## CI release matrix

`.github/workflows/stackmanage-release.yml` defines two jobs that produce the six requested artifacts:

- Linux: `.deb` and `.rpm` for x64 and arm64 (installs `rpm` tooling on the runner).
- Windows: NSIS installer and portable `.exe` for x64.

Each job generates `CHECKSUMS.txt` and uploads artifacts. The workflow has not been executed in this environment; it is configuration plus a reproducible command set, not evidence of six green artifacts.
