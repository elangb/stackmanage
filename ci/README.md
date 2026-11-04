# CI handoff

`checks.yml` is an intentionally inactive GitHub Actions template because all Phase 0 changes must remain inside the nested workspace. GitHub only executes repository-root `.github/workflows`; the release/integration agent must activate the template with explicit approval to modify root CI. No CI run is claimed.

The matrix requests actual Ubuntu and Windows runners. The desktop smoke test must run with its sandbox enabled. Ubuntu uses Xvfb; Windows uses its native session. Arm64 packaging and installer/upgrade/uninstall acceptance need separate real hosts. `test:desktop` covers bootstrap IPC only.

`php-build.yml` is another inactive template. It builds the pinned PHP 8.5.12
runtime on `ubuntu-latest`, verifies the artifact, and uploads the tar.gz,
SHA-256 and manifest. It requires a Docker-capable runner and has not been
executed; activation needs the same explicit root-workflow approval.
