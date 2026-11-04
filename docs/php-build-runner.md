# PHP 8.5.12 build runner

The PHP build runner produces a reproducible Linux x64 PHP CLI + FPM runtime
artifact. It is a build-time deliverable only: no worker module, renderer page,
IPC channel, site manager or service lifecycle is added in this phase.

The artifact is intended to be extracted under a per-user StackManage data
directory by a later worker module. It never installs into a system prefix and
does not require root on the host.

## Pin and provenance

| Field | Value |
|---|---|
| Version | `8.5.12` |
| Release date | `2026-10-21` |
| Source | `https://www.php.net/distributions/php-8.5.12.tar.gz` |
| Source SHA-256 | `81a0f450349e84b08eb43faa85f8a4c835684f3cc1c50471775d1317a046c525` |
| Source bytes | `24469403` |
| Source metadata | `https://www.php.net/releases/index.php?json=1&version=8.5.12` |
| Licence | PHP-3.01; bundled components have their own notices |
| Licence evidence | <https://www.php.net/license/> and the upstream `LICENSE` file |
| Target | `linux-x64` only |
| Prefix | `/opt/php/8.5.12` |

The SHA-256 was cross-checked against the php.net releases JSON and against a
local download on 2026-11-05. Do not commit the tarball. The Docker build
context only accepts the already-downloaded tarball;
`scripts/php/build-php-runtime.sh` verifies the source before staging a
temporary context and the Dockerfile verifies it again before extraction.

## Prerequisites

- Linux x86_64 host.
- Docker with a working daemon, or rootless/rootful Podman.
- Network access to `www.php.net` and `snapshot.ubuntu.com`.
- `curl`, `tar`, `gzip`, `sha256sum` (or `shasum`).
- `node` or `jq` for manifest verification. The project already requires Node 24.
- About 2 GiB of free space for the source cache, build layers and artifact.
- No host root privileges.

The script deliberately rejects non-x86_64 hosts and non-Linux hosts. PHP
`linux-arm64` is not accepted by this runner until a separate execution report
exists.

## Commands

```sh
cd stackmanage

# Build, verify, and write release/php/*
./scripts/php/build-php-runtime.sh

# Verify an existing artifact without Docker/Podman
./scripts/php/build-php-runtime.sh --verify-only

# Rebuild with an explicit cache/output location and fewer make jobs
./scripts/php/build-php-runtime.sh --force --jobs 2 \
  --cache-dir "$HOME/.cache/stackmanage/php" \
  --output-dir release/php

# Choose an engine explicitly
STACKMANAGE_CONTAINER_ENGINE=podman ./scripts/php/build-php-runtime.sh
```

Outputs (all under `release/php/`, which is git-ignored):

| File | Meaning |
|---|---|
| `php-8.5.12-linux-x64.tar.gz` | runtime artifact |
| `php-8.5.12-linux-x64.tar.gz.sha256` | `sha256sum` sidecar |
| `php-8.5.12-linux-x64.manifest.json` | version, source, configure, dependency and verification evidence |
| `build.log` | bounded build/export diagnostic log |

The script is idempotent: a valid existing artifact is verified and reused.
`--force` re-runs the export. The source cache is reused only after its size and
SHA-256 match the pin. The build and export runs are bounded by `--timeout`
(default 3600 seconds, minimum 60, maximum 86400), and make jobs are bounded to
1–8 (default `min(4, nproc)`).

## Build image layout

`build/php/Dockerfile` has four stages:

1. `ubuntu-base` — `ubuntu:24.04` pinned by digest, APT switched to an immutable
   snapshot.
2. `builder` — build dependencies, verified source extraction, configure, make,
   static extension link, strip, runtime configuration and provenance bundle.
3. `runtime` — only runtime shared libraries, non-root `php` user (UID/GID
   10001), copied `/opt/php/8.5.12`, health check and FPM default command.
4. `export` — the runtime plus pinned `jq` and the deterministic export script.
   This is the target the host script runs; the `runtime` stage remains the slim
   image for a later worker integration.

### apt pinning and bootstrap

Ubuntu package versions drift. The build uses:

- base image digest
  `ubuntu:24.04@sha256:78d4744ead1f5b19b04d0df558ab182a5300903900755e515b2ca4d10eb2044d`;
- Ubuntu snapshot `20261021T000000Z` (`https://snapshot.ubuntu.com/ubuntu/...`);
- exact package versions in the Dockerfile.

The minimal Ubuntu base does not contain `ca-certificates`, so the first APT
step bootstraps `ca-certificates` from the base image's signed HTTP archive.
That bootstrap is the only unpinned step. Immediately after that, the sources
are replaced by the snapshot and `ca-certificates`, `openssl` and `libssl3t64`
are reinstalled at the exact snapshot versions. Release files and package
signatures are still verified by the Ubuntu archive keyring; the snapshot
`Valid-Until` check is disabled because the snapshot Release file is historical.

If the snapshot service no longer serves the pinned timestamp, the build fails
before compilation. It never silently falls back to a moving archive.

### Build dependencies (exact snapshot versions)

| Package | Version |
|---|---|
| autoconf | `2.71-3` |
| bison | `2:3.8.2+dfsg-1ubuntu0.24.04.1` |
| build-essential | `12.10ubuntu1` |
| libargon2-dev | `0~20190702+dfsg-4build1` |
| libcurl4-openssl-dev | `8.5.0-2ubuntu10.16` |
| libfreetype-dev | `2.13.2+dfsg-1ubuntu0.2` |
| libicu-dev | `74.2-1ubuntu3.1` |
| libjpeg-turbo8-dev | `2.1.5-2ubuntu2` |
| libncurses-dev | `6.4+20240113-1ubuntu2.2` |
| libonig-dev | `6.9.9-1build1` |
| libpcre2-dev | `10.42-4ubuntu2.1` |
| libpng-dev | `1.6.43-5ubuntu0.7` |
| libreadline-dev | `8.2-4build1` |
| libsodium-dev | `1.0.18-1ubuntu0.24.04.1` |
| libsqlite3-dev | `3.45.1-1ubuntu2.8` |
| libssl-dev | `3.0.13-0ubuntu3.16` |
| libwebp-dev | `1.3.2-0.4build3` |
| libxml2-dev | `2.9.14+dfsg-1.3ubuntu3.10` |
| libxslt1-dev | `1.1.39-0exp1ubuntu0.24.04.3` |
| libzip-dev | `1.7.3-1.1ubuntu2` |
| pkg-config | `1.8.1-2build1` |
| re2c | `3.1-1build1` |
| zlib1g-dev | `1:1.3.dfsg-3.1ubuntu2.2` |

The builder image also inherits the snapshot-pinned `ca-certificates`,
`openssl`, `libssl3t64` and `build-essential` dependency chain. The manifest
records the complete resolved package list, not only this table.

### Runtime libraries (exact snapshot versions)

| Package | Version |
|---|---|
| libargon2-1 | `0~20190702+dfsg-4build1` |
| libcrypt1 | `1:4.4.36-4build1` |
| libcurl4t64 | `8.5.0-2ubuntu10.16` |
| libfreetype6 | `2.13.2+dfsg-1ubuntu0.2` |
| libicu74 | `74.2-1ubuntu3.1` |
| libjpeg-turbo8 | `2.1.5-2ubuntu2` |
| libonig5 | `6.9.9-1build1` |
| libpcre2-8-0 | `10.42-4ubuntu2.1` |
| libpng16-16t64 | `1.6.43-5ubuntu0.7` |
| libreadline8t64 | `8.2-4build1` |
| libsodium23 | `1.0.18-1ubuntu0.24.04.1` |
| libsqlite3-0 | `3.45.1-1ubuntu2.8` |
| libstdc++6 | `14.2.0-4ubuntu2~24.04.1` |
| libtinfo6 | `6.4+20240113-1ubuntu2.2` |
| libwebp7 | `1.3.2-0.4build3` |
| libxml2 | `2.9.14+dfsg-1.3ubuntu3.10` |
| libxslt1.1 | `1.1.39-0exp1ubuntu0.24.04.3` |
| libzip4t64 | `1.7.3-1.1ubuntu2` |
| tzdata | `2026e-0ubuntu0.24.04.1` |
| zlib1g | `1:1.3.dfsg-3.1ubuntu2.2` |

APT pulls the transitive dependencies of `libcurl4t64`, `libicu74`, `libwebp7`
and the other runtime libraries from the same snapshot. The manifest records
the complete runtime package inventory.

## Configure line

The exact argument list is in `build/php/configure-args.txt` and is also copied
into the artifact at `share/stackmanage/configure-args.txt`:

```sh
./configure \
  --prefix=/opt/php/8.5.12 \
  --exec-prefix=/opt/php/8.5.12 \
  --sysconfdir=/opt/php/8.5.12/etc \
  --localstatedir=/opt/php/8.5.12/var \
  --with-config-file-path=/opt/php/8.5.12/etc \
  --with-config-file-scan-dir=/opt/php/8.5.12/etc/conf.d \
  --with-libdir=lib/x86_64-linux-gnu \
  --enable-option-checking=fatal \
  --disable-debug \
  --disable-debug-assertions \
  --disable-cgi \
  --disable-phpdbg \
  --disable-short-tags \
  --disable-rpath \
  --without-pear \
  --enable-fpm \
  --with-fpm-user=www-data \
  --with-fpm-group=www-data \
  --with-openssl \
  --with-zlib \
  --with-external-pcre \
  --with-curl \
  --with-zip \
  --enable-intl \
  --enable-mbstring \
  --with-mysqli=mysqlnd \
  --with-pdo-mysql=mysqlnd \
  --with-sodium \
  --with-password-argon2 \
  --enable-gd \
  --with-jpeg \
  --with-webp \
  --with-freetype \
  --with-xsl \
  --with-readline \
  --enable-bcmath \
  --enable-calendar \
  --enable-exif \
  --enable-pcntl \
  --enable-soap \
  --enable-sockets \
  --disable-opcache-jit
```

PHP 8.5 builds OPcache into the binary unconditionally. The
`--enable-opcache`/`--disable-opcache` flags were removed in 8.5, and no
`opcache.so` is produced. Do not add `zend_extension=opcache.so` to `php.ini`;
PHP prints a warning. `opcache.enable` and `opcache.enable_cli` still work.
This build disables the JIT (`--disable-opcache-jit`) for a smaller and more
conservative runtime.

All extensions in this build are linked statically. The artifact does not need
an `extension_dir` or `extension=` lines. Build flags:

```sh
CFLAGS="-O2 -pipe -fstack-protector-strong -D_FORTIFY_SOURCE=2 \
  -fdebug-prefix-map=/build/php-src=/usr/src/php \
  -ffile-prefix-map=/build/php-src=/usr/src/php"
CXXFLAGS="$CFLAGS"
LDFLAGS="-Wl,-O1 -Wl,-z,relro -Wl,-z,now"
SOURCE_DATE_EPOCH=1792540800
```

`SOURCE_DATE_EPOCH` is the release timestamp `2026-10-21T00:00:00Z`. GCC uses
it for `__DATE__`/`__TIME__`, so PHP's embedded build date is deterministic.
The export script checks that `php -v` and `php-fpm -v` contain
`built: Oct 21 2026 00:00:00`; it fails instead of silently producing a
non-reproducible artifact.

## Expected output

The source build should produce:

```text
$ /opt/php/8.5.12/bin/php -v
PHP 8.5.12 (cli) (built: Oct 21 2026 00:00:00) (NTS)
Copyright (c) The PHP Group
Zend Engine v4.5.12, Copyright (c) Zend Technologies
    with Zend OPcache v8.5.12, Copyright (c), by Zend Technologies
```

```text
$ /opt/php/8.5.12/sbin/php-fpm -v
PHP 8.5.12 (fpm-fcgi) (built: Oct 21 2026 00:00:00) (NTS)
Copyright (c) The PHP Group
Zend Engine v4.5.12, Copyright (c) Zend Technologies
    with Zend OPcache v8.5.12, Copyright (c), by Zend Technologies
```

```text
$ /opt/php/8.5.12/sbin/php-fpm -t \
    -y /opt/php/8.5.12/etc/php-fpm.conf \
    -p /opt/php/8.5.12
[05-Nov-2026 00:00:00] NOTICE: configuration file /opt/php/8.5.12/etc/php-fpm.conf test is successful
```

The timestamp in the FPM line is current wall-clock time. The manifest replaces
it with `[timestamp]` so the manifest remains deterministic. A non-root FPM
master may also emit `user`/`group` ignored warnings; the exit code must be 0
and the `test is successful` line must be present.

### Required extensions

The artifact must load at least:

`Core`, `Zend OPcache`, `bcmath`, `calendar`, `ctype`, `curl`, `date`, `dom`,
`exif`, `fileinfo`, `filter`, `gd`, `hash`, `iconv`, `intl`, `json`, `lexbor`,
`libxml`, `mbstring`, `mysqli`, `mysqlnd`, `openssl`, `pcntl`, `pcre`, `PDO`,
`pdo_mysql`, `pdo_sqlite`, `Phar`, `posix`, `random`, `readline`, `Reflection`,
`session`, `SimpleXML`, `soap`, `sockets`, `sodium`, `SPL`, `sqlite3`,
`standard`, `tokenizer`, `uri`, `xml`, `xmlreader`, `xmlwriter`, `xsl`, `zip`,
`zlib`.

Notes:

- `Zend OPcache` is always present in PHP 8.5; it is not a loadable module.
- `lexbor` and `uri` are always-built PHP 8.5 extensions; they are not a
  StackManage feature surface.
- `readline`, `pcntl` and some interactive behaviour are CLI-only. The FPM SAPI
  uses the same static build but does not expose every CLI-only extension.
- The manifest records the exact extension list parsed from `php -m`. The list
  above is the required subset checked by the exporter, not a promise that no
  other built-in extension exists.

## Default configuration

The artifact contains:

- `etc/php.ini` — production-safe defaults, static extensions, OPcache enabled,
  CLI OPcache disabled, `expose_php=Off`, `display_errors=Off`,
  `cgi.fix_pathinfo=0`, 256 MiB memory, 64 MiB uploads, UTC timezone.
- `etc/php-fpm.conf` — relative `pid`/`error_log` under the prefix,
  `daemonize=no`, relative `include = etc/php-fpm.d/*.conf`.
- `etc/php-fpm.d/www.conf` — loopback `127.0.0.1:9000`, dynamic pool with a
  small worker cap, `/status`, `/ping`, `security.limit_extensions=.php`,
  `clear_env=yes`, `catch_workers_output=yes`.

`php-fpm` relative paths resolve against the install prefix. A later worker can
run the binary with an explicit `-p <extracted-root>` and render its own config.
The build-time FPM user/group default is `www-data`; a non-root master ignores
those directives, and the worker is expected to render the current desktop user.
The artifact does not bind a public interface.

## Verify the artifact

```sh
cd stackmanage/release/php

# 1. Hash and manifest/tar safety checks, no Docker needed
../../scripts/php/build-php-runtime.sh --verify-only --output-dir .

# 2. Direct hash check
sha256sum -c php-8.5.12-linux-x64.tar.gz.sha256

# 3. Inspect the archive
tar -tzf php-8.5.12-linux-x64.tar.gz | sed -n '1,40p'
```

`--verify-only` checks the SHA-256 sidecar, the manifest's source/version/
artifact fields, the artifact byte count, required paths, absolute/traversal
paths and symlinks. It does not execute the binary.

To execute the artifact on a host that has the runtime libraries:

```sh
tmp="$(mktemp -d)"
tar -xzf php-8.5.12-linux-x64.tar.gz -C "$tmp"
prefix="$tmp/php-8.5.12-linux-x64"
"$prefix/bin/php" -v
"$prefix/sbin/php-fpm" -t -y "$prefix/etc/php-fpm.conf" -p "$prefix"
```

To execute it inside the export image without extracting on the host:

```sh
docker run --rm \
  --entrypoint /opt/php/8.5.12/bin/php \
  stackmanage/php-build:8.5.12-linux-x64-81a0f450349e -v
```

The image tag uses the first 12 characters of the source SHA-256. The export
image includes the runtime plus `jq`; the `runtime` stage is available for a
later slim deployment image.

## Reproducibility limits

The runner is deterministic under these conditions:

- The same `php-8.5.12.tar.gz` bytes (SHA-256 verified) and the same
  `SOURCE_DATE_EPOCH`.
- The same `ubuntu:24.04` digest and the same Ubuntu snapshot timestamp.
- The same exact APT package versions and the same compiler/linker from that
  snapshot.
- The same make job count does not change compiler output; if a future toolchain
  introduces order-dependent output, use `--jobs 1`.
- The same export tar options: `--sort=name`, `--mtime=@1792540800`,
  `--owner=0`, `--group=0`, `--numeric-owner`, `--format=gnu`, and
  `gzip -n -9`.

The export script fixes the build date, sorts package/module lists, sanitises
the FPM test timestamp, strips ASLR-dependent addresses from `ldd`, normalises
modes and rejects symlinks. The tar contains
numeric root ownership metadata for determinism; extracting as a non-root user
creates user-owned files. The file modes are `0644` for data and `0755` for
`bin/php`, `sbin/php-fpm` and directories, so extraction never needs root.

Known limits:

- The bootstrap `ca-certificates` install uses the base image's moving HTTP
  archive before the snapshot is enabled. It is immediately replaced by the
  pinned snapshot version, but the step itself is not immune to the live
  archive's availability.
- `snapshot.ubuntu.com` must continue to serve the pinned timestamp. If Canonical
  removes it, the build fails; it does not fall back to a moving archive.
- The source URL is on php.net. The SHA-256 pin, not the URL, is the authority.
- BuildKit/Podman caches may reuse layers; a cache hit does not weaken the
  source or package checks because the Dockerfile re-verifies the source and
  uses exact package versions.
- The manifest includes resolved package inventories. Those are deterministic
  for the snapshot and base digest, not for an arbitrary host.
- Docker and Podman are both supported, but only the CI-configured Docker path
  is intended for release automation. The authoring environment had neither
  runtime, so no actual image build is claimed by this document.
- `linux-arm64` and non-Linux hosts are rejected. No arm64 execution evidence
  exists.

## Security notes

- The build fetches only HTTPS source and APT snapshot content (the one HTTP
  bootstrap is GPG-verified), and verifies the source SHA-256 twice.
- No secret, token or credential is required. No secret is written to the
  build context, logs or manifest.
- The builder runs as root only inside the disposable builder container.
- The runtime image runs as UID/GID 10001 (`php`), not root.
- The export container runs with `--network none`, `--cap-drop ALL` and
  `no-new-privileges`; it writes only to the mounted output directory and
  `/tmp`.
- The archive is checked for absolute/traversal paths, symlinks, setuid/setgid
  files and world-writable files.
- The default FPM pool listens on loopback only. Authentication, proxying and
  public exposure are deliberately out of scope.
- `php.ini` disables `expose_php`, hides errors from responses and sets
  `cgi.fix_pathinfo=0`.

## CI

`ci/php-build.yml` is an inactive GitHub Actions template, consistent with
`ci/checks.yml` and `ci/platform.yml`: GitHub only executes repository-root
`.github/workflows`, so activation needs an explicit decision outside this
branch. When activated, the job:

1. runs on `ubuntu-latest`;
2. uses the preinstalled Docker daemon and least-privilege `contents: read`;
3. runs `./scripts/php/build-php-runtime.sh --output-dir release/php --jobs 4`;
4. runs `--verify-only`;
5. uploads the tar.gz, SHA-256 and manifest, plus `build.log` on failure.

No CI run is claimed here. The authoring environment has no Docker or Podman
binary, so the image build was not executed locally.

## Rollback

This phase has no deployment or service mutation. To abandon a bad build:

```sh
rm -rf release/php
```

The source cache is separate and can be removed with:

```sh
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/stackmanage/php"
```

A later worker integration must treat the artifact as immutable, verify the
sidecar before extraction, and keep the previous installation until the new
one passes `php -v` and `php-fpm -t`. Those worker semantics are not part of
this phase.
