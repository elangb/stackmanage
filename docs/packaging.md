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
- `THIRD_PARTY_NOTICES.md` is included under `resources/`; full Electron/Chromium notices still need to be bundled at release.
- The project license and a real homepage are not decided yet, so package metadata currently uses placeholders.
- Linux icon is original (`build/icon.png`); Windows `.ico` and macOS assets are not prepared.
