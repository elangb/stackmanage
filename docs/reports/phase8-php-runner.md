# Laporan PHP-RUNNER — Fase 8 (PHP 8.5.12 build runner)

## AGEN

PHP-RUNNER, branch `agent/php-runner`, worktree
`/tmp/opencode/stackmanage-php`. Baseline `55737f9` (integrasi Fase 7).
Tidak ada subagent. Perubahan hanya di `stackmanage/`; tidak ada kode/aset
legacy yang disalin. Tidak ada UI, worker module, IPC, situs, atau lifecycle
layanan yang ditambahkan pada fase ini.

## FASE

8 — build runner PHP 8.5.12 Linux x64: source resmi terpatok, Dockerfile
multi-stage Ubuntu 24.04, apt snapshot terpatok, artefak tar.gz deterministik,
manifest, verifikasi, dan template CI.

## STATUS

**Konfigurasi selesai; build container belum dieksekusi.** Lingkungan penulisan
tidak memiliki Docker maupun Podman. Script berhenti dengan pesan yang jelas
sebelum melakukan build:

```text
PHP_RUNTIME_FAILED: no container runtime found (docker or podman). Install one, or use --verify-only for an existing artifact. No build was attempted.
```

Source PHP 8.5.12 diunduh langsung dari `www.php.net` dan SHA-256-nya cocok
dengan nilai resmi. Artefak PHP yang sebenarnya **belum** dihasilkan. Semua
pemeriksaan statis yang feasible lulus, dan alur export/manifest diuji memakai
prefix PHP tiruan (bukan build PHP nyata). `linux-arm64`, Windows, worker, UI,
FPM lifecycle, dan integrasi situs **belum** ada.

## YANG SELESAI

- Pin source resmi:
  - `https://www.php.net/distributions/php-8.5.12.tar.gz`;
  - SHA-256 `81a0f450349e84b08eb43faa85f8a4c835684f3cc1c50471775d1317a046c525`;
  - 24.469.403 byte; tanggal rilis `2026-10-21`;
  - dicek silang dengan releases JSON php.net dan unduhan lokal pada
    `2026-11-05`;
  - lisensi PHP-3.01; `LICENSE` dan `README.REDIST.BINS` ikut ke artefak,
    bersama notice komponen bundled yang relevan.
- `build/php/Dockerfile`:
  - base `ubuntu:24.04` dipatok lewat digest
    `sha256:78d4744ead1f5b19b04d0df558ab182a5300903900755e515b2ca4d10eb2044d`;
  - apt memakai snapshot `20261021T000000Z` dan versi paket eksplisit;
  - bootstrap `ca-certificates` dari HTTP archive base image, lalu langsung
    diganti versi snapshot yang dipatok;
  - stage `ubuntu-base` → `builder` → `runtime` → `export`;
  - dependency build lengkap untuk FPM, mbstring/oniguruma, curl, zip, openssl,
    zlib, gd (PNG/JPEG/WebP/FreeType), intl/ICU, readline, xsl, sodium, argon2,
    sqlite3, dan pcre2;
  - configure dengan `--enable-fpm`, user/group `www-data`, prefix
    `/opt/php/8.5.12`, `--disable-debug`, `--disable-opcache-jit`, dan
    `--enable-option-checking=fatal`;
  - catatan penting: PHP 8.5 selalu membangun OPcache ke dalam binary; flag
    `--enable-opcache` sudah dihapus, jadi tidak dipakai;
  - binary di-strip, header/phpize/php-config/man tidak ikut, runtime image
    memakai user non-root UID/GID 10001, healthcheck `php-fpm -t`;
  - prefix runtime memuat `etc/php.ini`, `etc/php-fpm.conf`,
    `etc/php-fpm.d/www.conf`, metadata build, daftar paket apt, serta lisensi.
- `scripts/php/build-php-runtime.sh`:
  - deteksi `docker`/`podman` (atau `STACKMANAGE_CONTAINER_ENGINE`), gagal jelas
    bila tidak ada atau daemon tidak bisa dipakai;
  - unduh source via HTTPS dengan batas waktu/ukuran/retry, verifikasi ukuran dan
    SHA-256, cache sumber;
  - stage build context sementara, build `--target export`, lalu jalankan
    export dengan `--network none`, `--cap-drop ALL`,
    `no-new-privileges`, dan user host (rootless memakai `--user 0:0`);
  - argv array, tanpa `eval`, path di-quote, `set -euo pipefail`;
  - idempoten: artefak valid diverifikasi dan dipakai ulang; `--force` untuk
    membangun ulang; `--verify-only` tidak membutuhkan container runtime;
  - batas `--jobs 1..8` (default `min(4, nproc)`) dan `--timeout 60..86400`
    detik (default 3600);
  - output: `release/php/php-8.5.12-linux-x64.tar.gz`,
    `.tar.gz.sha256`, `.manifest.json`, dan `build.log`.
- `build/php/export-runtime.sh`:
  - verifikasi `php -v`, `php-fpm -v`, version/ZTS/debug/int-size,
    `php-fpm -t`, daftar extension wajib, dan `ldd` tanpa `not found`;
  - menolak symlink, path absolut/traversal, setuid/setgid, dan world-writable;
  - tar deterministik: `--sort=name`, `--mtime=@1792540800`, owner/group 0,
    numeric owner, format gnu, `gzip -9 -n`;
  - manifest JSON berisi source, artifact, builder, configure, apt build/runtime,
    extension, `ldd`, dan hasil verifikasi;
  - timestamp `php-fpm -t` disanitasi menjadi `[timestamp]` agar manifest tetap
    deterministik; log uji FPM dihapus sebelum tar.
- `build/php/configure-args.txt`, `expected-extensions.txt`, `php.ini`,
  `php-fpm.conf`, `www.conf`.
- `ci/php-build.yml`: template inactive untuk `ubuntu-latest`, build + verify +
  upload artifact; belum diaktifkan dan belum dijalankan.
- `docs/php-build-runner.md`: dependency eksak, configure line, expected
  `php -v`/`php-fpm -v`/`php-fpm -t`, daftar extension, verifikasi tar,
  batas reproduktibilitas, keamanan, CI, dan rollback.
- `THIRD_PARTY_NOTICES.md` dan `docs/legal/vendor-catalog.tsv` diperbarui untuk
  pin PHP 8.5.12 dan postur redistribusi.
- `docs/operation-plan.md` dan `docs/feature-matrix.md` diperbarui dengan
  kontrak/evidence fase ini; tidak ada klaim build nyata.

## BUKTI

Mesin: Linux x86_64, Ubuntu 26.04, Node `v24.21.0`, pnpm `10.32.1`,
PHP host `8.5.12` (paket distro, bukan hasil build runner). Tidak ada Docker
atau Podman.

| Pemeriksaan | Hasil |
|---|---|
| `curl https://www.php.net/releases/index.php?json=1&version=8.5.12` | JSON resmi berisi SHA-256 `81a0f450…c525`, tanggal `21 Oct 2026` |
| `curl https://www.php.net/distributions/php-8.5.12.tar.gz` + `sha256sum` | Cocok `81a0f450349e84b08eb43faa85f8a4c835684f3cc1c50471775d1317a046c525`, 24.469.403 byte |
| `bash -n` pada 3 script | Lulus |
| ShellCheck `0.10.0` (`-x`) pada 3 script | 0 temuan |
| Hadolint `2.14.0` pada Dockerfile | 0 temuan |
| `php -c build/php/php.ini -v` dan `php -m` (PHP host 8.5.12) | Lulus; config valid, stderr kosong |
| `php-fpm -t` memakai binary `php8.5-fpm` distro yang diekstrak + config kita | `configuration file … test is successful`, exit 0 |
| Export/verify harness dengan prefix PHP tiruan (ELF palsu, 48 extension) | `PHP_EXPORT_OK`, `PHP_RUNTIME_VERIFY_OK`, `PHP_RUNTIME_ALREADY_BUILT`; dua run menghasilkan tar dan manifest identik (SHA `ae0f6554…a2f0` untuk tar harness) |
| `scripts/php/build-php-runtime.sh` tanpa container runtime | Gagal jelas, tidak ada build yang diklaim |
| Fake engine (`docker info` sukses, `docker build` sengaja gagal) | Source download + cache hit, context staging, build args, cleanup `EXIT`, dan pesan gagal spesifik terverifikasi; tidak ada image yang diklaim |
| `pnpm legal:verify` | `LEGAL_VERIFY_OK: 611 checks, 143 production packages, 64 vendor rows, 244 SBOM components` |
| YAML parse `ci/php-build.yml` + template CI lain | OK (PyYAML) |

Harness tiruan hanya menguji alur export, tar, manifest, dan verifikasi host.
Harness itu **bukan** bukti bahwa PHP berhasil dikompilasi atau bahwa extension
benar-benar tertaut.

## RISIKO/BUG

- **Tinggi:** build container belum pernah dijalankan. Versi apt eksak berasal
  dari snapshot dan sudah dicek keberadaannya, tetapi resolusi dependency apt,
  ketersediaan snapshot, dan keberhasilan `configure`/`make` belum dibuktikan
  pada mesin ini. Jangan menganggap artefak PHP sudah ada.
- **Tinggi:** `SOURCE_DATE_EPOCH` harus dihormati GCC 13 di image. Export
  sengaja gagal bila `php -v` tidak memuat build date `Oct 21 2026 00:00:00`;
  ini mencegah klaim deterministik palsu, tetapi juga berarti build bisa gagal
  pada toolchain yang tidak patuh.
- **Tinggi:** `snapshot.ubuntu.com` harus tetap menyediakan timestamp
  `20261021T000000Z`. Tidak ada fallback ke archive bergerak.
- **Tinggi:** bootstrap `ca-certificates` memakai HTTP archive base image
  sebelum snapshot HTTPS aktif. Paket tetap diverifikasi GPG dan langsung
  diganti versi snapshot, tetapi langkah bootstrap itu sendiri tidak reproducible
  sepenuhnya.
- **Sedang:** `linux-arm64` dan Windows ditolak/belum didukung. Tidak ada
  eksekusi arm64.
- **Sedang:** default `www-data` pada FPM hanya default build. Master non-root
  mengabaikannya; worker wajib merender user/group sebenarnya. Artefak belum
  memiliki lifecycle FPM, health probe runtime, log tail, atau integrasi situs.
- **Sedang:** FPM default hanya loopback `127.0.0.1:9000`; belum ada auth/proxy.
  Jangan expose tanpa kontrol akses.
- **Sedang:** `php.ini` memakai default operasional 256 MiB memory dan 64 MiB
  upload. Ini bukan kuota produk; worker dapat menggantinya.
- **Sedang:** artefak membawa lisensi PHP dan notice bundled, tetapi image
  runtime juga berisi paket Ubuntu. Redistribusi image/installer harus membawa
  notice Ubuntu/Debian dan komponen dinamis terkait.
- **Rendah:** `--verify-only` memeriksa hash, manifest, dan isi tar; ia tidak
  mengeksekusi binary. Eksekusi memerlukan runtime libraries host atau image.
- **Rendah:** CI masih template inactive; belum ada bukti run GitHub Actions.

## DEPENDENSI

- WORKFLOW: modul worker PHP, ekstraksi aman, render config per user, lifecycle
  FPM, health/log, dan integrasi situs.
- PLATFORM: bukti Linux arm64 bila akan didukung.
- QA: jalankan build nyata pada Docker/Podman, lalu bandingkan SHA artefak dari
  dua run bersih.
- PACKAGING: notice PHP/Ubuntu dan keputusan apakah runtime image ikut
  didistribusikan atau hanya artifact tar.
- LEGAL: review ulang bila source/extension/paket berubah.

## LANGKAH BERIKUT

1. Jalankan `./scripts/php/build-php-runtime.sh` pada mesin dengan Docker atau
   Podman; simpan `build.log`, `php -v`, `php-fpm -v`, `php-fpm -t`, `php -m`,
   dan `ldd`.
2. Jalankan dua build bersih dan bandingkan SHA-256 tar.gz + manifest; jika
   berbeda, telusuri timestamp/urutan file sebelum menaikkan klaim
   deterministik.
3. Verifikasi resolusi apt eksak di dalam container; sesuaikan versi hanya
   dengan snapshot baru dan catat di manifest.
4. Implementasikan worker module PHP secara terpisah: pin/unduh/verifikasi,
   staging, ekstraksi tanpa symlink/path escape, render `php.ini`/FPM pool,
   start/stop/restart, readiness, log tail, dan uninstall terkelola.
5. Tambahkan bukti Linux arm64 hanya setelah ada eksekusi nyata.
6. Aktifkan `ci/php-build.yml` menjadi root workflow dengan persetujuan eksplisit;
   jangan mengklaim CI run sebelum benar-benar berjalan.
